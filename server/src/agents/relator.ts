// F6 — Relator: cards de orçamento, resumo comparativo, aprovar/recusar, fechamento.
import {
  all, getProvider, getRequest, getRp, now, postMessage, run, setRequestStatus, updateRp, type RpRow,
} from '../db.ts';
import { formatDateBR, reais } from '../lib/time.ts';
import { enqueue } from '../whatsapp.ts';
import { hasClaude, runTurn, textOf } from './claude.ts';
import { pushEvent } from './negociador.ts';

const THANKS_DISMISS = 'Oi! Obrigado pelo retorno e pela atenção. Acabei resolvendo com outro profissional, mas guardo teu contato pra próxima.';
const THANKS_CANCEL = 'Oi! Obrigado pelo retorno. Acabei não precisando mais do serviço, mas guardo teu contato. Valeu!';

/** Prestadores ainda "em aberto" (receberiam o obrigado). */
const OPEN = ['contatado', 'respondeu', 'orcou', 'sem_resposta', 'aprovado'];

export function onQuote(rpId: number) {
  const rp = getRp(rpId)!;
  const prov = getProvider(rp.provider_id)!;
  const req = getRequest(rp.request_id)!;
  if (req.status === 'contatando') setRequestStatus(req.id, 'orcamentos');
  postMessage(req.id, 'assistant', `${prov.name} mandou orçamento: ${reais(rp.quote_value_cents)}.`, { kind: 'quote', rpId });
  scheduleComparison(req.id);
}

// ---------- resumo comparativo (≥2 orçamentos) ----------
const compTimers = new Map<number, NodeJS.Timeout>();
function scheduleComparison(requestId: number) {
  const t = compTimers.get(requestId);
  if (t) clearTimeout(t);
  compTimers.set(requestId, setTimeout(() => {
    compTimers.delete(requestId);
    void comparison(requestId);
  }, 15_000));
}

const COMP_SYSTEM = 'Tu compara orçamentos de prestadores de serviço pro cliente. Escreve 2 a 4 frases curtas, em português do Brasil, tom simples ("tu"), sem markdown nem listas: diz qual é mais barato, quem pode ir antes e o que chama atenção nas condições ou nas notas. Não decide pelo cliente.';

async function comparison(requestId: number) {
  if (!hasClaude()) return;
  const quotes = all<RpRow & { name: string; rating_google: number | null; reviews_google: number | null; our_rating_avg: number | null }>(
    `SELECT rp.*, p.name, p.rating_google, p.reviews_google, p.our_rating_avg FROM request_providers rp JOIN providers p ON p.id = rp.provider_id
     WHERE rp.request_id = ? AND rp.quote_value_cents IS NOT NULL AND rp.status IN ('orcou','aprovado','respondeu','fechado')`,
    requestId,
  );
  if (quotes.length < 2) return;
  const req = getRequest(requestId)!;
  const list = quotes
    .map((q) => `- ${q.name}: ${reais(q.quote_value_cents)}; condições: ${q.quote_conditions || '-'}; disponibilidade: ${q.quote_availability || '-'}; nota Google: ${q.rating_google ?? '-'} (${q.reviews_google ?? 0} avaliações)${q.our_rating_avg ? `; nota no Resolvedor: ${q.our_rating_avg.toFixed(1)}` : ''}`)
    .join('\n');
  try {
    const r = await runTurn({
      system: COMP_SYSTEM,
      messages: [{ role: 'user', content: `Serviço: ${req.category} — ${req.summary}\n\nOrçamentos:\n${list}` }],
      effort: 'low',
      maxTokens: 8000,
    });
    const text = textOf(r.message);
    if (text) postMessage(requestId, 'assistant', text, { kind: 'comparison' });
  } catch (err) {
    console.warn('[F6] resumo falhou', err);
  }
}

// ---------- ações do usuário ----------
export class FlowError extends Error {
  constructor(message: string, public httpStatus = 400) {
    super(message);
  }
}

export function approve(requestId: number, rpId: number) {
  const rp = getRp(rpId);
  if (!rp || rp.request_id !== requestId) throw new FlowError('Prestador não encontrado', 404);
  if (rp.quote_value_cents == null) throw new FlowError('Esse prestador ainda não mandou orçamento', 409);
  if (!['orcou', 'respondeu', 'aprovado'].includes(rp.status)) throw new FlowError(`Não dá pra aprovar nesse estado (${rp.status})`, 409);
  const req = getRequest(requestId)!;
  if (['fechado', 'avaliado', 'cancelado'].includes(req.status)) throw new FlowError('Pedido já encerrado', 409);
  if (rp.status === 'aprovado') return;
  // só um aprovado por vez
  for (const o of all<RpRow>("SELECT * FROM request_providers WHERE request_id = ? AND status = 'aprovado' AND id != ?", requestId, rpId)) {
    updateRp(o.id, { status: 'orcou' });
    pushEvent(o.id, 'O cliente desistiu de aprovar teu orçamento por enquanto. Não fecha nada; se o prestador perguntar, diz que o cliente ainda está decidindo.');
  }
  updateRp(rpId, { status: 'aprovado', last_activity_at: now() });
  setRequestStatus(requestId, 'aguardando_confirmacao');
  postMessage(requestId, 'system_event', `Aprovado. Vou confirmar dia e horário com ${getProvider(rp.provider_id)?.name ?? 'o prestador'}.`);
  pushEvent(rpId, 'O cliente aprovou este orçamento. Confirma o dia e horário com o prestador e chama confirmar_fechamento quando ele confirmar.');
}

export function reject(requestId: number, rpId: number) {
  const rp = getRp(rpId);
  if (!rp || rp.request_id !== requestId) throw new FlowError('Prestador não encontrado', 404);
  if (['fechado', 'recusado_pelo_usuario', 'dispensado'].includes(rp.status)) return;
  const wasApproved = rp.status === 'aprovado';
  updateRp(rpId, { status: 'recusado_pelo_usuario', last_activity_at: now() });
  if (wasApproved) setRequestStatus(requestId, 'orcamentos');
  pushEvent(rpId, 'O cliente recusou este orçamento. Agradece ("obrigado, vou avaliar") e encerra a conversa, sem insistir.');
}

/** Chamado pela tool confirmar_fechamento (já checou status 'aprovado'). */
export function closeDeal(rpId: number, scheduledIso: string | null) {
  const rp = getRp(rpId)!;
  const prov = getProvider(rp.provider_id)!;
  const ts = now();
  updateRp(rpId, { status: 'fechado', last_activity_at: ts });
  setRequestStatus(rp.request_id, 'fechado', {
    closed_at: ts,
    scheduled_for: scheduledIso,
    closed_provider_id: rp.provider_id,
    closed_value_cents: rp.quote_value_cents,
  });
  postMessage(
    rp.request_id,
    'assistant',
    `Fechado com ${prov.name}${rp.quote_value_cents != null ? ` por ${reais(rp.quote_value_cents)}` : ''}${scheduledIso ? `, ${formatDateBR(scheduledIso)}` : ''}. Depois eu te pergunto como foi.`,
  );
  // dispensa os outros com um obrigado (ligado por padrão)
  for (const o of all<RpRow>(
    `SELECT * FROM request_providers WHERE request_id = ? AND id != ? AND status IN (${OPEN.map(() => '?').join(',')})`,
    rp.request_id, rpId, ...OPEN,
  )) {
    updateRp(o.id, { status: 'dispensado' });
    enqueue(o.id, THANKS_DISMISS, 5000 + Math.random() * 20_000);
  }
  // quem ainda nem foi contatado: tira da fila
  dropUnsent(rp.request_id, rpId);
}

function dropUnsent(requestId: number, exceptRpId: number) {
  run(
    `DELETE FROM outbox WHERE sent_at IS NULL AND request_provider_id IN
       (SELECT id FROM request_providers WHERE request_id = ? AND id != ? AND status = 'na_fila')`,
    requestId, exceptRpId,
  );
  for (const o of all<RpRow>("SELECT * FROM request_providers WHERE request_id = ? AND id != ? AND status = 'na_fila'", requestId, exceptRpId)) {
    updateRp(o.id, { status: 'dispensado' });
  }
}

export function cancelRequest(requestId: number) {
  const req = getRequest(requestId);
  if (!req) throw new FlowError('Pedido não encontrado', 404);
  if (req.status === 'cancelado') return;
  // não contatados ainda: só tira da fila
  dropUnsent(requestId, -1);
  for (const o of all<RpRow>(
    `SELECT * FROM request_providers WHERE request_id = ? AND status IN (${[...OPEN, 'fechado', 'pausado'].map(() => '?').join(',')})`,
    requestId, ...OPEN, 'fechado', 'pausado',
  )) {
    updateRp(o.id, { status: 'dispensado' });
    enqueue(o.id, THANKS_CANCEL, 3000 + Math.random() * 15_000);
  }
  for (const o of all<RpRow>("SELECT * FROM request_providers WHERE request_id = ? AND status = 'sugerido'", requestId)) {
    updateRp(o.id, { status: 'excluido' });
  }
  setRequestStatus(requestId, 'cancelado');
  postMessage(requestId, 'system_event', 'Pedido cancelado. Avisei quem já tinha sido contatado.');
}
