// Ponto de entrada do canal oficial: escolhe o fornecedor, recebe o webhook (durável),
// trata opt-in/opt-out e repassa mensagens pros handlers dos agentes (F3).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, now, run } from '../db.ts';
import { recordOptIn, recordOptOut, touchInbound } from './store.ts';
import { applyDeliveryStatus, drainOutbox, enqueue, outboxRowByMsgId, recoverOutbox, type OutboxRow } from './outbox.ts';
import { StubChannel } from './stub.ts';
import { TwilioChannel, twilioConfigFromEnv } from './twilio.ts';
import type { Channel, InboundEvent, InboundMessage } from './types.ts';

export { enqueue, OutboxError, onSendFailure } from './outbox.ts';
export type { InboundMessage } from './types.ts';

const cfg = twilioConfigFromEnv();
export const channel: Channel = cfg ? new TwilioChannel(cfg) : new StubChannel();

// ---------- opt-in / opt-out ----------

/**
 * Palavras que valem como "para de me mandar". Comparação sem acento e sem caixa.
 * Errar pra aceitar é de propósito: opt-out não reconhecido vira denúncia de spam na Meta,
 * que derruba a reputação do número inteiro (lição do Convivar).
 */
const STOP_WORDS = ['parar', 'pare', 'sair', 'cancelar', 'descadastrar', 'remover', 'nao quero', 'stop', 'unsubscribe'];
const START_WORDS = ['voltar', 'quero receber', 'quero voltar'];

export function normalize(s: string) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Só a mensagem curta conta como comando ("parar" sim; "não quero que pare no meio" não). */
function isCommand(text: string, words: string[]) {
  const t = normalize(text);
  return t.length > 0 && t.length <= 40 && words.some((w) => t === w || t.startsWith(w + ' ') || t.endsWith(' ' + w));
}

export type MessageContext = {
  /** a mensagem nossa a que a pessoa respondeu (clique em botão de template), quando houver */
  repliedTo: OutboxRow | null;
};
type MessageHandler = (msg: InboundMessage, ctx: MessageContext) => Promise<void> | void;
let messageHandler: MessageHandler | null = null;
type ConsentHandler = (phone: string, kind: 'opt_in' | 'opt_out') => void;
let consentHandler: ConsentHandler | null = null;
/** Avisado quando alguém confirma ou cancela o recebimento (o marketplace ativa/desativa o prestador). */
export function onConsentChange(fn: ConsentHandler) {
  consentHandler = fn;
}
/** Os agentes (F3) se registram aqui pra receber o que não for comando de canal. */
export function onInboundMessage(fn: MessageHandler) {
  messageHandler = fn;
}

async function handleMessage(msg: InboundMessage) {
  touchInbound(msg.from, now(), msg.profileName);
  const repliedTo = msg.repliedToMsgId ? outboxRowByMsgId(msg.repliedToMsgId) ?? null : null;
  const said = msg.buttonText || msg.text;

  if (msg.buttonId === 'optin_sim') {
    recordOptIn(msg.from, `botão "${msg.buttonText ?? 'Sim, quero receber'}" (resposta a ${repliedTo?.template_key ?? 'mensagem'} #${repliedTo?.id ?? '?'})`);
    consentHandler?.(msg.from, 'opt_in');
    enqueue({ to: msg.from, text: 'Combinado! Quando aparecer um pedido pra ti, te aviso por aqui. Se quiser parar, é só mandar SAIR.' });
    return;
  }
  if (msg.buttonId === 'optin_nao' || msg.buttonId === 'parar' || isCommand(said, STOP_WORDS)) {
    recordOptOut(msg.from, msg.buttonText ? `botão "${msg.buttonText}"` : said);
    consentHandler?.(msg.from, 'opt_out');
    // a pessoa acabou de escrever, a janela está aberta: a confirmação pode ir em texto livre
    // (a única mensagem que ainda pode sair depois do opt-out; vai direto, sem passar pela trava)
    await channel.sendText(msg.from, 'Pronto, não vamos mais te mandar mensagens. Se mudar de ideia, manda VOLTAR.').catch(() => {});
    return;
  }
  if (isCommand(said, START_WORDS)) {
    recordOptIn(msg.from, `mensagem "${said.slice(0, 100)}"`);
    consentHandler?.(msg.from, 'opt_in');
    enqueue({ to: msg.from, text: 'Pronto, voltaste a receber mensagens do Desenrola.' });
    return;
  }
  if (messageHandler) await messageHandler(msg, { repliedTo });
  else console.log(`[whatsapp] mensagem recebida sem handler (${msg.providerMsgId})`);
}

// ---------- entrada durável ----------

type InboundRow = { id: number; kind: string; payload_json: string };

/** Grava os eventos antes de qualquer processamento. Duplicados (retry da Twilio) são ignorados. */
export function storeEvents(events: InboundEvent[]) {
  const t = now();
  let fresh = 0;
  for (const ev of events) {
    const r = run(
      'INSERT OR IGNORE INTO wa_inbound (provider_msg_id, kind, status_value, from_phone, payload_json, received_at) VALUES (?, ?, ?, ?, ?, ?)',
      ev.providerMsgId, ev.kind, ev.kind === 'status' ? ev.status : '', ev.kind === 'message' ? ev.from : null, JSON.stringify(ev), t,
    );
    fresh += Number(r.changes);
  }
  return fresh;
}

let processing: Promise<void> | null = null;
/** Processa o que estiver pendente, em ordem de chegada. Chamado após cada webhook e na subida. */
export function processInbound(): Promise<void> {
  if (processing) return processing.then(() => processInbound());
  processing = (async () => {
    for (;;) {
      const row = get<InboundRow>("SELECT id, kind, payload_json FROM wa_inbound WHERE state = 'pending' ORDER BY id LIMIT 1");
      if (!row) break;
      try {
        const ev = JSON.parse(row.payload_json) as InboundEvent;
        if (ev.kind === 'status') applyDeliveryStatus(ev.providerMsgId, ev.status, ev.errorCode);
        else await handleMessage(ev);
        run("UPDATE wa_inbound SET state = 'done', processed_at = ? WHERE id = ?", now(), row.id);
      } catch (e) {
        // não repete pra sempre: fica marcado pra olhar no admin
        run("UPDATE wa_inbound SET state = 'failed', error = ?, processed_at = ? WHERE id = ?", String((e as Error).message).slice(0, 500), now(), row.id);
        console.error('[whatsapp] erro processando entrada', row.id, e);
      }
    }
  })().finally(() => {
    processing = null;
  });
  return processing;
}

// ---------- rotas ----------

export async function registerWhatsAppRoutes(app: FastifyInstance) {
  // escopo próprio: o parser de formulário só existe aqui
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });
    scope.post('/webhooks/whatsapp', async (req, reply) => {
      const params = (req.body ?? {}) as Record<string, string>;
      const sig = req.headers['x-twilio-signature'];
      // falha fechada: sem credencial ou assinatura errada, ninguém entra
      if (!channel.verifySignature(typeof sig === 'string' ? sig : undefined, params)) {
        req.log.warn('webhook do WhatsApp com assinatura inválida (ou canal sem credencial)');
        return reply.code(403).send({ error: 'Assinatura inválida' });
      }
      storeEvents(channel.parseWebhook(params));
      void processInbound();
      return reply.type('text/xml').send('<Response/>');
    });
  });

  // só em desenvolvimento com o canal falso: simula o prestador escrevendo e mostra a fila
  if (channel.name === 'stub' && process.env.NODE_ENV !== 'production') {
    app.post('/api/dev/whatsapp/inbound', async (req) => {
      const b = z
        .object({
          from: z.string().regex(/^\d{12,13}$/),
          text: z.string().default(''),
          buttonId: z.string().nullish(),
          buttonText: z.string().nullish(),
          repliedToMsgId: z.string().nullish(),
        })
        .parse(req.body);
      const ev: InboundMessage = {
        kind: 'message',
        providerMsgId: `SMdev${Date.now()}${Math.floor(Math.random() * 1000)}`,
        from: b.from,
        profileName: null,
        text: b.text,
        buttonId: b.buttonId ?? null,
        buttonText: b.buttonText ?? null,
        repliedToMsgId: b.repliedToMsgId ?? null,
        media: [],
      };
      storeEvents([ev]);
      await processInbound();
      return { ok: true, id: ev.providerMsgId };
    });
    app.get('/api/dev/whatsapp/outbox', async () =>
      all('SELECT id, to_phone, kind, template_key, payload_json, ref, state, attempts, last_error, provider_msg_id, delivery_status, not_before FROM wa_outbox ORDER BY id DESC LIMIT 50'),
    );
  }
}

// ---------- subida ----------

let timer: NodeJS.Timeout | null = null;
export function startChannel(log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }) {
  if (channel.real) log.info('WhatsApp oficial: Twilio');
  else if (process.env.NODE_ENV === 'production') log.error('WhatsApp oficial em STUB em produção: nada sai. Configure TWILIO_* e WHATSAPP_WEBHOOK_URL.');
  else log.warn('WhatsApp oficial em stub (sem TWILIO_*): mensagens só no log. Simule respostas em POST /api/dev/whatsapp/inbound.');
  recoverOutbox();
  void processInbound();
  if (timer) return;
  const tick = () => void drainOutbox(channel).catch((e) => log.error(`[whatsapp] outbox: ${(e as Error).message}`));
  tick();
  timer = setInterval(tick, 2000);
  timer.unref();
}
