// V2 — do diagnóstico à negociação: matching, oferta por template, roteamento das respostas no número único,
// fila de uma negociação por prestador e passagem pra humano.
//
// Estados de request_providers (mesma tabela da V1, sentido novo):
//   sugerido → (dispatch) contatado [template pedido_novo enviado]
//   contatado → respondeu [tocou em "Ver detalhes": negociação ativa] | na_fila [aceitou, mas está em outra negociação]
//             | recusou ["Agora não" / não atende] | sem_resposta [não abriu]
//   respondeu → orcou → fechado [cliente aprovou: contatos trocados] | recusado_pelo_usuario | dispensado
//   pausado = conversa com um humano do Desenrola (handoff)
import { bus } from '../events.ts';
import {
  all, get, getRequest, getRp, now, postMessage, run, setRequestStatus, updateRp, type RpRow,
} from '../db.ts';
import { clientByPhone, clientOfRequest } from '../auth/clients.ts';
import { enqueue, OutboxError, type InboundMessage } from '../channel/index.ts';
import type { MessageContext } from '../channel/index.ts';
import { windowOpen } from '../channel/store.ts';
import { eligibleProviders, getProviderV2, providerByPhone, type ProviderV2 } from './providers.ts';
import { suggestFor } from './suggestions.ts';

export class OfferError extends Error {
  constructor(message: string, public httpStatus = 400, public code?: string) {
    super(message);
  }
}

/** máximo de prestadores avisados por pedido (com pouco estoque, vão todos os elegíveis até aqui) */
export const MAX_OFFERS = 8;
/** "Agora não": quanto tempo sem receber pedidos */
export const SNOOZE_MS = 48 * 3600_000;

/** negociação em andamento (só uma por prestador) */
export const NEGOTIATING = ['respondeu'] as const;
/** ainda em aberto do lado do prestador */
export const OPEN_OFFER = ['contatado', 'na_fila', 'respondeu', 'orcou', 'sem_resposta', 'pausado'] as const;
const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(',');

// os agentes se registram aqui (evita import circular com negociador.ts)
type NegotiatorHooks = {
  start: (rpId: number, providerText: string | null) => void;
  providerMessage: (rpId: number, text: string) => void;
  event: (rpId: number, text: string) => void;
  clientReply: (rpId: number, text: string) => void;
};
let neg: NegotiatorHooks = { start: () => {}, providerMessage: () => {}, event: () => {}, clientReply: () => {} };
export function setNegotiatorHooks(h: NegotiatorHooks) {
  neg = h;
}

// ---------- 1. matching ----------

/** Depois do diagnóstico: quem do nosso banco pode atender. Não manda nada ainda. */
export function findProviders(requestId: number) {
  const req = getRequest(requestId);
  if (!req) throw new OfferError('Pedido não encontrado', 404);
  if (!req.category) throw new OfferError('Ainda não tenho o diagnóstico desse pedido', 409);
  if (!['diagnostico', 'sem_prestadores', 'escolhendo'].includes(req.status)) throw new OfferError(`Não dá pra buscar nessa etapa (${req.status})`, 409);
  const city = req.city || clientOfRequest(requestId)?.city || 'Porto Alegre';
  const found = eligibleProviders(req.category, city, req.neighborhood).slice(0, MAX_OFFERS);

  run("DELETE FROM request_providers WHERE request_id = ? AND status IN ('sugerido','excluido')", requestId);
  found.forEach((p, i) =>
    run(
      `INSERT INTO request_providers (request_id, provider_id, position, selected, status) VALUES (?, ?, ?, 1, 'sugerido')
       ON CONFLICT(request_id, provider_id) DO NOTHING`,
      requestId, p.id, i,
    ),
  );
  const where = [req.neighborhood, city].filter(Boolean).join(', ');
  if (!found.length) {
    setRequestStatus(requestId, 'sem_prestadores');
    postMessage(
      requestId,
      'assistant',
      `Ainda não tenho ${req.category} cadastrado no Desenrola que atenda ${where}. Vou ver os contatos que conheço da tua região.`,
    );
    console.log(`[matching] sem prestador: ${req.category} em ${where} (pedido ${requestId})`);
    void suggestFor(requestId).catch((e) => console.error('[sugestões]', e));
    return { count: 0 };
  }
  setRequestStatus(requestId, 'escolhendo');
  postMessage(
    requestId,
    'assistant',
    found.length === 1
      ? `Tenho 1 ${req.category} que atende ${where}. Quando quiser, clica em "Pedir orçamento" que eu aviso ele.`
      : `Tenho ${found.length} profissionais que atendem ${where}. Desmarca quem tu não quer e clica em "Pedir orçamentos": eu aviso todos ao mesmo tempo.`,
    { kind: 'providers' },
  );
  return { count: found.length };
}

// ---------- 2. oferta ----------

/** Resumo que vai no template (sem dado pessoal; o diagnóstico já escreve assim). */
/** O relato do cliente com as palavras dele (o que ele escreveu primeiro), curto. Sem dado pessoal: é o texto do problema. */
function offerStory(requestId: number, fallback: string | null) {
  // o diagnóstico escreve um relato curto juntando o que o cliente contou (inclusive a resposta à pergunta extra)
  let curto: string | undefined;
  try {
    curto = JSON.parse(getRequest(requestId)?.details_json ?? '{}').relato_curto;
  } catch {
    curto = undefined;
  }
  const first = get<{ content: string }>("SELECT content FROM messages WHERE request_id = ? AND role = 'user' ORDER BY id LIMIT 1", requestId)?.content;
  return (curto || first || fallback || 'serviço').replace(/\s+/g, ' ').trim().replace(/[.!?…]+$/, '').slice(0, 200);
}

export function dispatch(requestId: number) {
  const req = getRequest(requestId);
  if (!req) throw new OfferError('Pedido não encontrado', 404);
  if (req.status !== 'escolhendo') throw new OfferError(`Não dá pra pedir orçamento nessa etapa (${req.status})`, 409);
  const client = clientOfRequest(requestId);
  if (!client || client.is_guest) throw new OfferError('Pra eu avisar os profissionais, confirma teu celular.', 409, 'login_required');
  const selected = all<RpRow>("SELECT * FROM request_providers WHERE request_id = ? AND selected = 1 AND status = 'sugerido' ORDER BY position", requestId);
  if (!selected.length) throw new OfferError('Seleciona pelo menos um profissional', 400);

  for (const rp of all<RpRow>("SELECT * FROM request_providers WHERE request_id = ? AND selected = 0 AND status = 'sugerido'", requestId)) {
    updateRp(rp.id, { status: 'excluido' });
  }
  let sent = 0;
  for (const rp of selected) {
    const p = getProviderV2(rp.provider_id)!;
    try {
      enqueue({
        to: p.phone_e164!,
        template: 'pedido_novo',
        vars: {
          pedido: String(requestId),
          categoria: req.category ?? 'serviço',
          bairro: req.neighborhood || req.city || '-',
          relato: offerStory(req.id, req.title),
        },
        ref: `rp:${rp.id}`,
      });
      updateRp(rp.id, { status: 'contatado', offered_at: now(), last_activity_at: now() });
      sent++;
    } catch (e) {
      updateRp(rp.id, { status: 'excluido' });
      console.warn(`[oferta] ${p.name} fora: ${(e as Error).message}`);
    }
  }
  if (!sent) {
    setRequestStatus(requestId, 'sem_prestadores');
    postMessage(requestId, 'assistant', 'Não consegui avisar nenhum dos profissionais agora. Tenta de novo em instantes.');
    return { sent };
  }
  setRequestStatus(requestId, 'contatando');
  postMessage(
    requestId,
    'system_event',
    `Avisei ${sent === 1 ? '1 profissional' : `${sent} profissionais`}. Os orçamentos costumam chegar em algumas horas; te mostro aqui assim que chegarem.`,
    { kind: 'progress' },
  );
  return { sent };
}

// ---------- 3. respostas no número único ----------

const rpOfProvider = (providerId: number, statuses: readonly string[], order = 'last_activity_at DESC') =>
  get<RpRow>(`SELECT * FROM request_providers WHERE provider_id = ? AND status IN (${inList(statuses)}) ORDER BY ${order}, id DESC LIMIT 1`, providerId);

/** Qual pedido essa mensagem do prestador é sobre. */
export function routeMessage(p: ProviderV2, ctx: MessageContext): RpRow | null {
  const m = ctx.repliedTo?.ref?.match(/^rp:(\d+)$/);
  if (m) {
    const rp = getRp(Number(m[1]));
    if (rp && rp.provider_id === p.id) return rp;
  }
  return (
    // a negociação ativa vem antes de um pedido que já orçou e está esperando o cliente
    rpOfProvider(p.id, ['respondeu', 'pausado']) ??
    rpOfProvider(p.id, ['orcou']) ??
    rpOfProvider(p.id, ['contatado', 'sem_resposta'], 'offered_at DESC') ??
    // conversa recente sobre um pedido já fechado (ex.: "beleza, vou ligar pra ele")
    get<RpRow>(
      "SELECT * FROM request_providers WHERE provider_id = ? AND status = 'fechado' AND last_activity_at >= ? ORDER BY last_activity_at DESC LIMIT 1",
      p.id, new Date(Date.now() - 7 * 24 * 3600_000).toISOString(),
    ) ??
    null
  );
}

/** Handler do canal: tudo que não é comando de opt-in/opt-out chega aqui. */
export async function onInbound(msg: InboundMessage, ctx: MessageContext) {
  const p = providerByPhone(msg.from);
  const open = openHandoff(msg.from);
  if (open) {
    bus.publish({ type: 'admin.inbox' });
    return; // um humano está na conversa
  }
  if (!p) {
    if (clientByPhone(msg.from)) return onClientMessage(msg, ctx);
    createHandoff(msg.from, null, null, 'Mensagem de um número que não é prestador cadastrado');
    return;
  }
  const text = msg.text.trim();
  const rp = routeMessage(p, ctx);
  if (!rp) {
    reply(msg.from, 'Oi! No momento não tenho nenhum pedido aberto pra ti. Assim que aparecer um na tua região, te aviso por aqui.');
    return;
  }
  updateRp(rp.id, { last_inbound_at: now(), last_activity_at: now() });

  if (msg.buttonId === 'agora_nao') return snooze(p, rp);
  if (['recusado_pelo_usuario', 'dispensado', 'excluido', 'recusou'].includes(rp.status)) {
    reply(msg.from, `O pedido #${rp.request_id} já foi encerrado. Obrigado! Quando aparecer outro na tua região, te aviso.`);
    return;
  }
  if (rp.status === 'contatado' || rp.status === 'sem_resposta' || rp.status === 'na_fila') {
    // "Ver detalhes", "Continuar" ou texto livre em cima da oferta: quer orçar
    return accept(p, rp, msg.buttonId ? null : text || null);
  }
  if (msg.media.length && !text) {
    neg.providerMessage(rp.id, '[mandou uma imagem/arquivo, que tu não consegue ver]');
    return;
  }
  if (msg.buttonId) neg.providerMessage(rp.id, `[tocou no botão "${msg.buttonText ?? msg.buttonId}"]`);
  else if (text) neg.providerMessage(rp.id, text);
}

/** URL do site (links nos templates do cliente). */
export const siteUrl = (path = '') => `${(process.env.PUBLIC_URL || 'http://localhost:5173').replace(/\/$/, '')}${path}`;

/**
 * Cliente escrevendo no nosso WhatsApp. Se for resposta a uma pergunta de profissional (template
 * cliente_pergunta_prestador, ref "ask:<rpId>"), vira resposta pro negociador; senão, aponta pro site.
 */
function onClientMessage(msg: InboundMessage, ctx: MessageContext) {
  const c = clientByPhone(msg.from)!;
  const text = msg.text.trim();
  const viaRef = ctx.repliedTo?.ref?.match(/^ask:(\d+)$/);
  const recent = get<{ ref: string }>(
    "SELECT ref FROM wa_outbox WHERE to_phone = ? AND ref LIKE 'ask:%' AND created_at >= ? ORDER BY id DESC LIMIT 1",
    msg.from, new Date(Date.now() - 24 * 3600_000).toISOString(),
  );
  const rpId = Number((viaRef ?? recent?.ref.match(/^ask:(\d+)$/))?.[1] ?? 0);
  const rp = rpId ? getRp(rpId) : undefined;
  const req = rp ? getRequest(rp.request_id) : undefined;
  if (text && rp && req && req.client_id === c.id && OPEN_OFFER.includes(rp.status as (typeof OPEN_OFFER)[number])) {
    postMessage(req.id, 'user', text);
    neg.clientReply(rp.id, text);
    reply(msg.from, 'Mandei tua resposta pro profissional. Os orçamentos aparecem no site.');
    return;
  }
  reply(msg.from, `Oi! Pra ver teus pedidos e os orçamentos, entra em ${siteUrl()} com este número.`);
}

/** Avisa o cliente no WhatsApp (se ele aceitou receber). Falha silenciosa: o site sempre mostra. */
export function notifyClient(requestId: number, template: 'cliente_orcamento_chegou' | 'cliente_pergunta_prestador', vars: Record<string, string>, ref?: string) {
  const c = clientOfRequest(requestId);
  if (!c) return;
  try {
    enqueue({ to: c.phone, template, vars, ref: ref ?? `req:${requestId}` });
  } catch (e) {
    if (!(e instanceof OutboxError)) throw e;
  }
}

function reply(phone: string, text: string) {
  try {
    enqueue({ to: phone, text });
  } catch (e) {
    console.warn(`[oferta] resposta não enviada: ${(e as Error).message}`);
  }
}

function snooze(p: ProviderV2, rp: RpRow) {
  run('UPDATE providers SET paused_until = ? WHERE id = ?', new Date(Date.now() + SNOOZE_MS).toISOString(), p.id);
  if (OPEN_OFFER.includes(rp.status as (typeof OPEN_OFFER)[number])) {
    updateRp(rp.id, { status: 'recusou' });
    postMessage(rp.request_id, 'system_event', `${p.name} não pode pegar esse pedido agora.`);
  }
  reply(p.phone_e164!, 'Tranquilo! Te deixo uns dias sem pedidos e depois volto a avisar por aqui.');
  promoteNext(p.id);
  checkExhausted(rp.request_id);
}

/** O prestador quer orçar. Se já está negociando outro pedido, entra na fila. */
function accept(p: ProviderV2, rp: RpRow, firstText: string | null) {
  const req = getRequest(rp.request_id)!;
  if (['fechado', 'avaliado', 'cancelado'].includes(req.status)) {
    updateRp(rp.id, { status: 'dispensado' });
    reply(p.phone_e164!, `O pedido #${req.id} já foi resolvido. Obrigado! Quando aparecer outro na tua região, te aviso.`);
    return;
  }
  const busy = get<RpRow>("SELECT * FROM request_providers WHERE provider_id = ? AND status = 'respondeu' AND id != ? LIMIT 1", p.id, rp.id);
  if (!rp.viewed_at) updateRp(rp.id, { viewed_at: now() });
  if (busy) {
    if (rp.status !== 'na_fila') {
      updateRp(rp.id, { status: 'na_fila', queued_at: now() });
      reply(p.phone_e164!, `Anotado o pedido #${req.id}! Assim que terminarmos o #${busy.request_id}, te passo os detalhes dele.`);
    }
    return;
  }
  updateRp(rp.id, { status: 'respondeu', last_activity_at: now() });
  postMessage(req.id, 'system_event', `${p.name} viu o pedido e está conversando comigo.`);
  neg.start(rp.id, firstText);
}

/** Quando a negociação ativa termina (orçou, recusou, encerrou), puxa o próximo pedido da fila desse prestador. */
export function promoteNext(providerId: number) {
  if (get('SELECT 1 FROM request_providers WHERE provider_id = ? AND status = ? LIMIT 1', providerId, 'respondeu')) return;
  const next = get<RpRow>("SELECT * FROM request_providers WHERE provider_id = ? AND status = 'na_fila' ORDER BY queued_at, id LIMIT 1", providerId);
  if (!next) return;
  const p = getProviderV2(providerId)!;
  if (!p.phone_e164 || !windowOpen(p.phone_e164)) {
    // janela fechada: a fila espera ele voltar a falar (o lembrete do scheduler chama de novo)
    updateRp(next.id, { status: 'contatado' });
    return;
  }
  accept(p, next, null);
}

/** Todo mundo recusou/sumiu e nenhum orçamento: avisa o cliente. */
export function checkExhausted(requestId: number) {
  const req = getRequest(requestId);
  if (!req || !['contatando', 'orcamentos'].includes(req.status)) return;
  const stillOpen = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM request_providers WHERE request_id = ? AND (status IN (${inList(OPEN_OFFER)}) OR quote_value_cents IS NOT NULL)`,
    requestId,
  )!.n;
  if (stillOpen) return;
  setRequestStatus(requestId, 'sem_prestadores');
  postMessage(requestId, 'assistant', 'Os profissionais que avisei não puderam pegar esse pedido. Já anotei pra trazer mais gente da tua região; se quiser, posso tentar de novo mais tarde.');
}

// ---------- 4. humano no meio (handoff) ----------

export type HandoffRow = { id: number; phone: string; provider_id: number | null; rp_id: number | null; reason: string; status: string; created_at: string; closed_at: string | null };

export const openHandoff = (phone: string) => get<HandoffRow>("SELECT * FROM handoffs WHERE phone = ? AND status = 'aberto' ORDER BY id DESC LIMIT 1", phone);

export function createHandoff(phone: string, providerId: number | null, rpId: number | null, reason: string) {
  const existing = openHandoff(phone);
  if (existing) return existing.id;
  const r = run('INSERT INTO handoffs (phone, provider_id, rp_id, reason, created_at) VALUES (?, ?, ?, ?, ?)', phone, providerId, rpId, reason.slice(0, 500), now());
  if (rpId) {
    const rp = getRp(rpId);
    if (rp && rp.status !== 'pausado') updateRp(rpId, { status: 'pausado', paused_from: rp.status });
  }
  console.log(`[handoff] aberto #${r.lastInsertRowid}: ${reason}`);
  bus.publish({ type: 'admin.inbox' });
  return Number(r.lastInsertRowid);
}

/** Fecha o atendimento humano. Com `resume`, o agente volta a conversar sabendo o que o humano disse. */
export function closeHandoff(id: number, resume: boolean) {
  const h = get<HandoffRow>('SELECT * FROM handoffs WHERE id = ?', id);
  if (!h) throw new OfferError('Atendimento não encontrado', 404);
  if (h.status !== 'aberto') return;
  run("UPDATE handoffs SET status = 'fechado', closed_at = ? WHERE id = ?", now(), id);
  if (h.rp_id) {
    const rp = getRp(h.rp_id);
    if (rp?.status === 'pausado') {
      const back = rp.paused_from && rp.paused_from !== 'pausado' ? rp.paused_from : 'respondeu';
      updateRp(rp.id, { status: back, paused_from: null });
      if (resume) {
        const said = all<{ payload_json: string }>(
          "SELECT payload_json FROM wa_outbox WHERE to_phone = ? AND ref = ? AND created_at >= ? ORDER BY id",
          h.phone, `handoff:${h.id}`, h.created_at,
        ).map((r) => JSON.parse(r.payload_json).text as string);
        neg.event(
          rp.id,
          `Uma pessoa da equipe do Desenrola atendeu o prestador por um tempo${said.length ? ` e disse: ${said.map((s) => `"${s}"`).join(' / ')}` : ''}. Agora tu retoma a conversa daqui.`,
        );
      }
    }
  }
  bus.publish({ type: 'admin.inbox' });
}

/** Resposta do humano pelo admin. Só dentro da janela de 24h. */
export function adminReply(phone: string, text: string) {
  const h = openHandoff(phone) ?? null;
  try {
    return enqueue({ to: phone, text, ref: h ? `handoff:${h.id}` : 'admin' });
  } catch (e) {
    if (e instanceof OutboxError && e.code === 'janela_fechada') {
      throw new OfferError('A janela de 24h dessa conversa fechou: só dá pra mandar template. Espera a pessoa escrever de novo.', 409, 'janela_fechada');
    }
    throw e;
  }
}
