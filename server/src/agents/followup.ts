// F7 — Follow-up pós-serviço: pergunta se foi feito e pede nota (1–5).
import { all, get, getProvider, getRequest, now, postMessage, run, setRequestStatus, type RequestRow } from '../db.ts';
import { FlowError } from './relator.ts';

const DAY = 24 * 3600_000;

/** Varredura do scheduler: scheduled_for + 1 dia, ou closed_at + 3 dias sem data. Idempotente por followup_sent_at. */
export function sweepFollowups() {
  const t = Date.now();
  for (const r of all<RequestRow>("SELECT * FROM requests WHERE status = 'fechado' AND followup_sent_at IS NULL AND closed_provider_id IS NOT NULL")) {
    const due = r.scheduled_for ? new Date(r.scheduled_for).getTime() + DAY : new Date(r.closed_at ?? r.updated_at).getTime() + 3 * DAY;
    if (t < due) continue;
    const res = run('UPDATE requests SET followup_sent_at = ? WHERE id = ? AND followup_sent_at IS NULL', now(), r.id);
    if (Number(res.changes) === 0) continue;
    const prov = getProvider(r.closed_provider_id!);
    const name = prov?.name ?? 'o prestador';
    postMessage(r.id, 'assistant', `O serviço foi feito? Que nota tu dá pro ${name}?`, { kind: 'rating', providerId: r.closed_provider_id!, providerName: name });
  }
}

export function rate(requestId: number, input: { providerId: number; stars: number; comment?: string | null; serviceDone?: boolean }) {
  const req = getRequest(requestId);
  if (!req) throw new FlowError('Pedido não encontrado', 404);
  const prov = getProvider(input.providerId);
  if (!prov) throw new FlowError('Prestador não encontrado', 404);
  const stars = Math.round(input.stars);
  if (!(stars >= 1 && stars <= 5)) throw new FlowError('Nota deve ser de 1 a 5');
  if (get('SELECT 1 FROM ratings WHERE request_id = ? AND provider_id = ?', requestId, input.providerId)) throw new FlowError('Já avaliado', 409);
  run(
    'INSERT INTO ratings (request_id, provider_id, stars, comment, service_done, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    requestId, input.providerId, stars, input.comment ?? null, input.serviceDone === false ? 0 : 1, now(),
  );
  const agg = get<{ avg: number; n: number }>('SELECT AVG(stars) AS avg, COUNT(*) AS n FROM ratings WHERE provider_id = ?', input.providerId)!;
  run('UPDATE providers SET our_rating_avg = ?, our_rating_count = ? WHERE id = ?', agg.avg, agg.n, input.providerId);
  setRequestStatus(requestId, 'avaliado');
  postMessage(requestId, 'system_event', input.serviceDone === false
    ? 'Anotado que o serviço não foi feito. Se quiser, abre um novo pedido que eu procuro outro.'
    : `Valeu pela nota! ${stars} estrela${stars > 1 ? 's' : ''} pro ${prov.name}.`);
}
