// Scheduler único (60s): lembrete de oferta não vista, expiração de oferta, follow-up do cliente. Idempotente por carimbo.
import { all, getProvider, getRequest, now, postMessage, run, updateRp, type RpRow } from '../db.ts';
import { hourBR } from '../lib/time.ts';
import { enqueue, OutboxError } from '../channel/index.ts';
import { checkExhausted, promoteNext } from '../marketplace/offers.ts';
import { sweepFollowups } from '../agents/followup.ts';

const H = 3600_000;

/**
 * Oferta enviada e não aberta: 1 lembrete (template) depois de 3h em horário comercial;
 * 24h depois do lembrete, vira "sem_resposta". Negociação parada há 24h também expira.
 */
export function sweepProviders() {
  const t = Date.now();
  const h = hourBR();
  const business = h >= 8 && h < 20;
  for (const rp of all<RpRow & { offered_at: string | null }>("SELECT * FROM request_providers WHERE status = 'contatado' AND offered_at IS NOT NULL")) {
    const req = getRequest(rp.request_id);
    if (!req || ['fechado', 'avaliado', 'cancelado'].includes(req.status)) continue;
    if (!rp.reminder_sent_at) {
      if (!business || t - new Date(rp.offered_at!).getTime() < 3 * H) continue;
      const claim = run('UPDATE request_providers SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL', now(), rp.id);
      if (Number(claim.changes) === 0) continue;
      const p = getProvider(rp.provider_id);
      if (!p?.phone_e164) continue;
      try {
        enqueue({
          to: p.phone_e164,
          template: 'prestador_lembrete',
          vars: { pedido: String(req.id), categoria: req.category ?? 'serviço', bairro: req.neighborhood || req.city || '-' },
          ref: `rp:${rp.id}`,
        });
      } catch (e) {
        if (!(e instanceof OutboxError)) throw e;
      }
    } else if (t - new Date(rp.reminder_sent_at).getTime() > 24 * H) {
      updateRp(rp.id, { status: 'sem_resposta' });
      checkExhausted(rp.request_id);
    }
  }
  // negociação aberta sem nenhum movimento há 24h: libera o prestador pra fila dele
  for (const rp of all<RpRow>("SELECT * FROM request_providers WHERE status = 'respondeu' AND last_activity_at IS NOT NULL")) {
    if (t - new Date(rp.last_activity_at!).getTime() < 24 * H) continue;
    updateRp(rp.id, { status: 'sem_resposta' });
    postMessage(rp.request_id, 'system_event', `${getProvider(rp.provider_id)?.name ?? 'Um profissional'} parou de responder.`);
    promoteNext(rp.provider_id);
    checkExhausted(rp.request_id);
  }
}

export function tick() {
  try {
    sweepProviders();
  } catch (e) {
    console.error('[scheduler] prestadores', e);
  }
  try {
    sweepFollowups();
  } catch (e) {
    console.error('[scheduler] follow-up', e);
  }
}

let timer: NodeJS.Timeout | null = null;
export function startScheduler() {
  if (timer) return;
  tick();
  timer = setInterval(tick, 60_000);
  timer.unref();
}
