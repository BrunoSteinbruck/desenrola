// Scheduler único (60s): lembretes F5, sem_resposta, expiração de Pix, follow-up F7. Idempotente por carimbo.
import { all, getProvider, now, postMessage, run, updateRp, type RpRow } from '../db.ts';
import { hourBR } from '../lib/time.ts';
import { enqueue, kickOutbox } from '../whatsapp.ts';
import { sweepPayments } from './payments.ts';
import { sweepFollowups } from '../agents/followup.ts';
import { pushNote } from '../agents/negociador.ts';

const H = 3600_000;
const REMINDER = 'Oi! Conseguiu ver minha mensagem? Se puder me passar um valor aproximado e quando consegue vir, já me ajuda bastante.';

export function sweepProviders() {
  const t = Date.now();
  const h = hourBR();
  const business = h >= 8 && h < 20;
  for (const rp of all<RpRow>("SELECT * FROM request_providers WHERE status = 'contatado' AND last_activity_at IS NOT NULL")) {
    const last = new Date(rp.last_activity_at!).getTime();
    if (!rp.reminder_sent_at) {
      if (business && t - last > 3 * H) {
        const r = run('UPDATE request_providers SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL', now(), rp.id);
        if (Number(r.changes) > 0) {
          enqueue(rp.id, REMINDER, Math.random() * 30_000);
          pushNote(rp.id, `Enviei um lembrete automático pro prestador: "${REMINDER}"`);
        }
      }
    } else if (t - new Date(rp.reminder_sent_at).getTime() > 24 * H) {
      updateRp(rp.id, { status: 'sem_resposta' });
      postMessage(rp.request_id, 'system_event', `${getProvider(rp.provider_id)?.name ?? 'Um prestador'} não respondeu.`);
    }
  }
}

export function tick() {
  try { sweepPayments(); } catch (e) { console.error('[scheduler] pagamentos', e); }
  try { sweepProviders(); } catch (e) { console.error('[scheduler] prestadores', e); }
  try { sweepFollowups(); } catch (e) { console.error('[scheduler] follow-up', e); }
  kickOutbox();
}

let timer: NodeJS.Timeout | null = null;
export function startScheduler() {
  if (timer) return;
  tick();
  timer = setInterval(tick, 60_000);
}
