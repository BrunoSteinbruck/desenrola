// F3 — Pagamento: Pix via Mercado Pago (com MP_ACCESS_TOKEN) ou simulado.
// Sem webhook (app local): polling no servidor a cada 5s até expires_at.
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { bus } from '../events.ts';
import { all, get, getRequest, getSetting, now, run, touchRequest } from '../db.ts';

export interface PaymentRow {
  id: number; request_id: number; provider: 'mercadopago' | 'simulado'; external_id: string | null;
  idempotency_key: string; status: string; amount_cents: number; qr_code: string | null;
  qr_base64: string | null; ticket_url: string | null; expires_at: string | null; created_at: string;
}

const EXPIRY_MIN = 30;
export const hasMercadoPago = () => !!process.env.MP_ACCESS_TOKEN;
export const getPayment = (id: number) => get<PaymentRow>('SELECT * FROM payments WHERE id = ?', id);

let onPaid: (requestId: number) => void = () => {};
export function setOnPaid(fn: (requestId: number) => void) {
  onPaid = fn;
}

export class PaymentError extends Error {
  constructor(message: string, public code: string, public httpStatus = 400) {
    super(message);
  }
}

/** ISO com fuso -03:00 (formato dos exemplos do MP). */
function isoBrasilia(d: Date): string {
  const t = new Date(d.getTime() - 3 * 3600_000).toISOString().replace('Z', '');
  return `${t}-03:00`;
}

export function payerEmail(): string {
  return getSetting('user_email') || process.env.MP_PAYER_EMAIL || '';
}

/** Pagamento pendente e ainda válido do pedido, se houver. */
export function activePayment(requestId: number): PaymentRow | undefined {
  const p = get<PaymentRow>("SELECT * FROM payments WHERE request_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", requestId);
  if (p && p.expires_at && new Date(p.expires_at).getTime() < Date.now()) {
    expire(p);
    return undefined;
  }
  return p;
}

export async function createPayment(requestId: number): Promise<PaymentRow> {
  const existing = activePayment(requestId);
  if (existing) return existing;
  const req = getRequest(requestId);
  const amountCents = Math.round((Number(getSetting('price_per_request')) || 15) * 100);
  const key = randomUUID();
  const expires = new Date(Date.now() + EXPIRY_MIN * 60_000);
  const description = `Resolvedor: ${req?.title ?? 'pedido ' + requestId}`.slice(0, 200);

  if (!hasMercadoPago()) {
    const fake = `00020126SIMULADO-RESOLVEDOR-${requestId}-${key.slice(0, 8)}`;
    const png = await QRCode.toDataURL(fake, { margin: 1, width: 280 });
    const res = run(
      `INSERT INTO payments (request_id, provider, idempotency_key, status, amount_cents, qr_code, qr_base64, expires_at, created_at)
       VALUES (?, 'simulado', ?, 'pending', ?, ?, ?, ?, ?)`,
      requestId, key, amountCents, fake, png.replace(/^data:image\/png;base64,/, ''), expires.toISOString(), now(),
    );
    return getPayment(Number(res.lastInsertRowid))!;
  }

  const email = payerEmail();
  if (!email) throw new PaymentError('Preciso do teu e-mail pra gerar o Pix (exigência do Mercado Pago). Preenche em Configurações.', 'email_required', 400);

  const resp = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': key,
    },
    body: JSON.stringify({
      transaction_amount: amountCents / 100,
      description,
      payment_method_id: 'pix',
      payer: { email },
      date_of_expiration: isoBrasilia(expires),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await resp.json().catch(() => ({}))) as any;
  if (!resp.ok) {
    console.error('[mp] erro ao criar pagamento', resp.status, JSON.stringify(data).slice(0, 500));
    throw new PaymentError(`Mercado Pago recusou a cobrança: ${data?.message ?? resp.status}`, 'mp_error', 502);
  }
  const td = data.point_of_interaction?.transaction_data ?? {};
  const res = run(
    `INSERT INTO payments (request_id, provider, external_id, idempotency_key, status, amount_cents, qr_code, qr_base64, ticket_url, expires_at, created_at)
     VALUES (?, 'mercadopago', ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    requestId, String(data.id), key, amountCents,
    td.qr_code ?? null, td.qr_code_base64 ?? null, td.ticket_url ?? null,
    data.date_of_expiration ? new Date(data.date_of_expiration).toISOString() : expires.toISOString(), now(),
  );
  const p = getPayment(Number(res.lastInsertRowid))!;
  if (data.status === 'approved') markPaid(p);
  else startPolling(p.id);
  return p;
}

function setStatus(p: PaymentRow, status: string) {
  run('UPDATE payments SET status = ? WHERE id = ?', status, p.id);
  bus.publish({ type: 'payment.updated', requestId: p.request_id, paymentId: p.id, status });
  touchRequest(p.request_id);
}

function markPaid(p: PaymentRow) {
  // idempotente: só a transição pending -> approved dispara o onPaid
  const r = run("UPDATE payments SET status = 'approved' WHERE id = ? AND status = 'pending'", p.id);
  if (Number(r.changes) === 0) return;
  bus.publish({ type: 'payment.updated', requestId: p.request_id, paymentId: p.id, status: 'approved' });
  touchRequest(p.request_id);
  stopPolling(p.id);
  onPaid(p.request_id);
}

let onExpired: (requestId: number, paymentId: number) => void = () => {};
export function setOnExpired(fn: (requestId: number, paymentId: number) => void) {
  onExpired = fn;
}

function expire(p: PaymentRow) {
  const r = run("UPDATE payments SET status = 'expired' WHERE id = ? AND status = 'pending'", p.id);
  stopPolling(p.id);
  if (Number(r.changes) === 0) return;
  bus.publish({ type: 'payment.updated', requestId: p.request_id, paymentId: p.id, status: 'expired' });
  touchRequest(p.request_id);
  onExpired(p.request_id, p.id);
}

export function simulatePayment(id: number): PaymentRow {
  const p = getPayment(id);
  if (!p) throw new PaymentError('Pagamento não encontrado', 'not_found', 404);
  if (p.provider !== 'simulado') throw new PaymentError('Só pagamentos simulados podem ser simulados', 'not_simulated', 400);
  if (p.status === 'expired') throw new PaymentError('Esse Pix expirou; gera outro.', 'expired', 409);
  if (p.status === 'pending') markPaid(p);
  return getPayment(id)!;
}

/** Cancela cobrança pendente (pedido cancelado). */
export function cancelPending(requestId: number) {
  for (const p of all<PaymentRow>("SELECT * FROM payments WHERE request_id = ? AND status = 'pending'", requestId)) {
    stopPolling(p.id);
    setStatus(p, 'cancelled');
  }
}

// ---------- polling MP ----------
const pollers = new Map<number, NodeJS.Timeout>();
function stopPolling(id: number) {
  const t = pollers.get(id);
  if (t) clearInterval(t);
  pollers.delete(id);
}
function startPolling(id: number) {
  if (pollers.has(id)) return;
  pollers.set(id, setInterval(() => void pollOnce(id), 5000));
}
async function pollOnce(id: number) {
  const p = getPayment(id);
  if (!p || p.status !== 'pending') return stopPolling(id);
  if (p.expires_at && new Date(p.expires_at).getTime() < Date.now()) return expire(p);
  if (p.provider !== 'mercadopago' || !p.external_id) return;
  try {
    const resp = await fetch(`https://api.mercadopago.com/v1/payments/${p.external_id}`, {
      headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return;
    const data = (await resp.json()) as { status?: string };
    if (data.status === 'approved') markPaid(p);
    else if (data.status === 'cancelled' || data.status === 'rejected') expire(p);
  } catch (err) {
    console.warn('[mp] polling falhou', (err as Error).message);
  }
}

/** Na subida e no scheduler: retoma polling e expira o que venceu. */
export function sweepPayments() {
  for (const p of all<PaymentRow>("SELECT * FROM payments WHERE status = 'pending'")) {
    if (p.expires_at && new Date(p.expires_at).getTime() < Date.now()) expire(p);
    else if (p.provider === 'mercadopago') startPolling(p.id);
  }
}
