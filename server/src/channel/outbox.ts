// Fila de saída do número oficial. Ninguém chama o fornecedor direto: tudo entra aqui.
// - template só pra quem deu opt-in (exceto os de confirmação/código);
// - nada pra quem pediu pra sair;
// - texto livre e botões só dentro da janela de 24h;
// - uma mensagem por vez por destinatário, na ordem, com intervalo mínimo;
// - retry com espera crescente quando o erro é temporário.
import { all, get, now, run } from '../db.ts';
import { getContact, setWaId, windowOpen } from './store.ts';
import { altWhatsAppBR } from '../services/phone.ts';
import { buildVars, contentSidFor, renderTemplate, TEMPLATES, type TemplateKey } from './templates.ts';
import { ChannelError, type Button, type Channel, type Phone } from './types.ts';
import { maskPhone } from './stub.ts';

export class OutboxError extends Error {
  constructor(
    message: string,
    readonly code: 'opt_out' | 'sem_opt_in' | 'janela_fechada' | 'template_sem_sid' | 'invalido',
  ) {
    super(message);
  }
}

export type OutboxRow = {
  id: number;
  to_phone: Phone;
  kind: 'template' | 'text' | 'interactive';
  template_key: TemplateKey | null;
  payload_json: string;
  ref: string | null;
  not_before: string;
  state: 'queued' | 'sending' | 'sent' | 'failed' | 'blocked';
  attempts: number;
  last_error: string | null;
  provider_msg_id: string | null;
  delivery_status: string | null;
};

export type Outgoing =
  | { to: Phone; template: TemplateKey; vars: Record<string, string>; ref?: string; delayMs?: number }
  | { to: Phone; text: string; ref?: string; delayMs?: number }
  | { to: Phone; body: string; buttons: Button[]; ref?: string; delayMs?: number };

/** intervalo mínimo entre duas mensagens pro mesmo número (bolhas seguidas) */
export const GAP_MS = 1500;
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [10_000, 30_000, 120_000, 600_000, 3600_000];

export function enqueue(m: Outgoing): number {
  const to = m.to.replace(/\D/g, '');
  if (!/^\d{12,13}$/.test(to)) throw new OutboxError(`Telefone inválido: ${maskPhone(to)}`, 'invalido');
  const c = getContact(to);
  if (c?.opt_out_at) throw new OutboxError('A pessoa pediu pra não receber mensagens', 'opt_out');

  let kind: OutboxRow['kind'];
  let templateKey: TemplateKey | null = null;
  let payload: unknown;
  if ('template' in m) {
    kind = 'template';
    templateKey = m.template;
    if (TEMPLATES[m.template].requiresOptIn && !c?.opt_in_at) {
      throw new OutboxError(`Sem opt-in pra receber "${m.template}"`, 'sem_opt_in');
    }
    payload = { vars: buildVars(m.template, m.vars) };
  } else {
    if (!windowOpen(to)) throw new OutboxError('Fora da janela de 24h: use um template', 'janela_fechada');
    if ('buttons' in m) {
      if (!m.buttons.length || m.buttons.length > 3) throw new OutboxError('Entre 1 e 3 botões', 'invalido');
      kind = 'interactive';
      payload = { body: m.body.slice(0, 1024), buttons: m.buttons };
    } else {
      if (!m.text.trim()) throw new OutboxError('Mensagem vazia', 'invalido');
      kind = 'text';
      payload = { text: m.text.slice(0, 4096) };
    }
  }

  // mantém a ordem e o intervalo em relação ao que já está na fila pra esse número
  const last = get<{ nb: string }>(
    "SELECT MAX(not_before) AS nb FROM wa_outbox WHERE to_phone = ? AND state IN ('queued', 'sending')",
    to,
  );
  let at = Date.now() + (m.delayMs ?? 0);
  if (last?.nb) at = Math.max(at, new Date(last.nb).getTime() + GAP_MS);
  const t = now();
  const res = run(
    'INSERT INTO wa_outbox (to_phone, kind, template_key, payload_json, ref, not_before, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    to, kind, templateKey, JSON.stringify(payload), m.ref ?? null, new Date(at).toISOString(), t, t,
  );
  return Number(res.lastInsertRowid);
}

/** Texto legível do que sai (pros logs, admin e histórico dos agentes). */
export function outboxText(row: Pick<OutboxRow, 'kind' | 'template_key' | 'payload_json'>): string {
  const p = JSON.parse(row.payload_json);
  if (row.kind === 'template') return renderTemplate(row.template_key!, p.vars);
  if (row.kind === 'interactive') return `${p.body} [${(p.buttons as Button[]).map((b) => b.title).join(' | ')}]`;
  return p.text;
}

export type SendFailure = { row: OutboxRow; error: string };
let onFailure: (f: SendFailure) => void = () => {};
export function onSendFailure(fn: (f: SendFailure) => void) {
  onFailure = fn;
}

let draining = false;

/** Manda o que estiver vencido. Uma por destinatário por rodada, na ordem de criação. */
export async function drainOutbox(channel: Channel): Promise<number> {
  if (draining) return 0;
  draining = true;
  let sent = 0;
  try {
    const due = all<OutboxRow>(
      `SELECT o.* FROM wa_outbox o
       WHERE o.state = 'queued' AND o.not_before <= ?
         AND o.id = (SELECT MIN(id) FROM wa_outbox x WHERE x.to_phone = o.to_phone AND x.state IN ('queued', 'sending'))
       ORDER BY o.not_before LIMIT 20`,
      now(),
    );
    for (const row of due) {
      const claim = run("UPDATE wa_outbox SET state = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND state = 'queued'", now(), row.id);
      if (Number(claim.changes) === 0) continue;
      try {
        const id = await sendRow(channel, row);
        run("UPDATE wa_outbox SET state = 'sent', provider_msg_id = ?, sent_at = ?, last_error = NULL, updated_at = ? WHERE id = ?", id, now(), now(), row.id);
        sent++;
      } catch (e) {
        const err = e as Error;
        const attempts = row.attempts + 1;
        const retry = (e instanceof ChannelError ? e.retryable : !(e instanceof OutboxError)) && attempts < MAX_ATTEMPTS;
        if (retry) {
          const at = new Date(Date.now() + BACKOFF_MS[attempts - 1]).toISOString();
          run("UPDATE wa_outbox SET state = 'queued', not_before = ?, last_error = ?, updated_at = ? WHERE id = ?", at, err.message.slice(0, 500), now(), row.id);
        } else {
          run("UPDATE wa_outbox SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?", err.message.slice(0, 500), now(), row.id);
          console.warn(`[whatsapp] falhou #${row.id} pra +${maskPhone(row.to_phone)}: ${err.message.slice(0, 200)}`);
          onFailure({ row: { ...row, state: 'failed' }, error: err.message });
        }
      }
    }
  } finally {
    draining = false;
  }
  return sent;
}

async function sendRow(channel: Channel, row: OutboxRow): Promise<string> {
  const c = getContact(row.to_phone);
  if (c?.opt_out_at) throw new OutboxError('opt-out depois de entrar na fila', 'opt_out');
  const p = JSON.parse(row.payload_json);
  // manda no formato que o WhatsApp conhece (ex.: sem o 9º dígito), se já aprendemos
  const to = c?.wa_id || row.to_phone;
  if (row.kind === 'template') {
    const sid = contentSidFor(row.template_key!) ?? (channel.real ? null : `stub:${row.template_key}`);
    if (!sid) throw new OutboxError(`Template "${row.template_key}" sem SID aprovado (WA_TPL_${row.template_key!.toUpperCase()})`, 'template_sem_sid');
    return channel.sendTemplate(to, sid, p.vars);
  }
  // a janela pode ter fechado enquanto a mensagem esperava na fila
  if (!windowOpen(row.to_phone)) throw new OutboxError('A janela de 24h fechou antes do envio', 'janela_fechada');
  if (row.kind === 'interactive') return channel.sendInteractive(to, p.body, p.buttons);
  return channel.sendText(to, p.text);
}

const STATUS_RANK: Record<string, number> = { queued: 0, accepted: 0, sending: 1, sent: 2, delivered: 3, read: 4 };

/** Callback de entrega: só avança (sent → delivered → read); falha sempre registra. */
export function applyDeliveryStatus(providerMsgId: string, status: string, errorCode: string | null) {
  const row = get<OutboxRow>('SELECT * FROM wa_outbox WHERE provider_msg_id = ?', providerMsgId);
  if (!row) return null;
  const failed = status === 'failed' || status === 'undelivered';
  const cur = STATUS_RANK[row.delivery_status ?? ''] ?? -1;
  if (failed || (STATUS_RANK[status] ?? -1) > cur) {
    run(
      'UPDATE wa_outbox SET delivery_status = ?, last_error = COALESCE(?, last_error), updated_at = ? WHERE id = ?',
      status, failed ? `entrega: ${status}${errorCode ? ` (${errorCode})` : ''}` : null, now(), row.id,
    );
    if (failed && retryOtherFormat(row, errorCode)) return row;
    if (failed) onFailure({ row: { ...row, delivery_status: status }, error: `entrega ${status} ${errorCode ?? ''}`.trim() });
  }
  return row;
}

/** Erros de "destinatário não existe/não está no sandbox": vale tentar o outro formato do número (9º dígito). */
const WRONG_RECIPIENT = new Set(['63003', '63015', '63024']);

/**
 * O WhatsApp não achou o número: se ainda não sabemos o formato certo, troca pelo outro (com ↔ sem o 9)
 * e manda de novo uma cópia. Só uma vez por telefone (o wa_id fica gravado).
 */
function retryOtherFormat(row: OutboxRow, errorCode: string | null) {
  if (!errorCode || !WRONG_RECIPIENT.has(errorCode)) return false;
  const c = getContact(row.to_phone);
  if (c?.wa_id) return false; // já tentamos o outro formato
  const alt = altWhatsAppBR(row.to_phone);
  if (!alt) return false;
  setWaId(row.to_phone, alt);
  const t = now();
  run(
    'INSERT INTO wa_outbox (to_phone, kind, template_key, payload_json, ref, not_before, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    row.to_phone, row.kind, row.template_key, row.payload_json, row.ref, t, t, t,
  );
  console.warn(`[whatsapp] ${errorCode} pra +${maskPhone(row.to_phone)}: tentando o outro formato do número`);
  return true;
}

/** Depois de cair no meio de um envio não dá pra saber se saiu: volta pra fila (duplicar é melhor que perder). */
export function recoverOutbox() {
  run("UPDATE wa_outbox SET state = 'queued', updated_at = ? WHERE state = 'sending'", now());
}

export const outboxRowByMsgId = (providerMsgId: string) =>
  get<OutboxRow>('SELECT * FROM wa_outbox WHERE provider_msg_id = ?', providerMsgId);
