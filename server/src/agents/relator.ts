// Relator (V2): cards de orçamento, resumo comparativo e as decisões do cliente
// (aprovar = fechar e trocar contatos; recusar; cancelar). Tudo que vai pro prestador fora da conversa é template.
import {
  all, get, getProvider, getRequest, getRp, getSetting, now, postMessage, run, setRequestStatus, updateRp, type RpRow,
} from '../db.ts';
import { reais } from '../lib/time.ts';
import { formatBR } from '../services/phone.ts';
import { enqueue, OutboxError } from '../channel/index.ts';
import { checkExhausted, OPEN_OFFER, promoteNext } from '../marketplace/offers.ts';
import { hasClaude, runTurn, textOf, MODELS } from './claude.ts';
import { pushEvent } from './negociador.ts';

export function onQuote(rpId: number) {
  const rp = getRp(rpId)!;
  const prov = getProvider(rp.provider_id)!;
  const req = getRequest(rp.request_id)!;
  if (req.status === 'contatando') setRequestStatus(req.id, 'orcamentos');
  postMessage(req.id, 'assistant', `${prov.name} mandou orçamento: ${reais(rp.quote_value_cents)}.`, { kind: 'quote', rpId });
  scheduleComparison(req.id);
  // a negociação ativa desse prestador terminou: se ele tem outro pedido na fila, começa
  promoteNext(rp.provider_id);
}

// ---------- resumo comparativo (≥2 orçamentos) ----------
const compTimers = new Map<number, NodeJS.Timeout>();
function scheduleComparison(requestId: number) {
  clearTimeout(compTimers.get(requestId));
  compTimers.set(
    requestId,
    setTimeout(() => {
      compTimers.delete(requestId);
      void comparison(requestId);
    }, 15_000),
  );
}

const COMP_SYSTEM =
  'Tu compara orçamentos de profissionais pro cliente. Escreve 2 a 4 frases curtas, em português do Brasil, tom simples ("tu"), sem markdown nem listas: diz qual é mais barato, quem pode ir antes e o que chama atenção nas condições ou nas notas. Não decide pelo cliente.';

async function comparison(requestId: number) {
  if (!hasClaude()) return;
  const quotes = all<RpRow & { name: string; our_rating_avg: number | null; our_rating_count: number }>(
    `SELECT rp.*, p.name, p.our_rating_avg, p.our_rating_count FROM request_providers rp JOIN providers p ON p.id = rp.provider_id
     WHERE rp.request_id = ? AND rp.quote_value_cents IS NOT NULL AND rp.status IN ('orcou','respondeu','fechado')`,
    requestId,
  );
  if (quotes.length < 2) return;
  const req = getRequest(requestId)!;
  const list = quotes
    .map(
      (q) =>
        `- ${q.name}: ${reais(q.quote_value_cents)}; condições: ${q.quote_conditions || '-'}; disponibilidade: ${q.quote_availability || '-'}` +
        (q.our_rating_count ? `; nota no Desenrola: ${q.our_rating_avg!.toFixed(1)} (${q.our_rating_count})` : '; ainda sem avaliações no Desenrola'),
    )
    .join('\n');
  try {
    const r = await runTurn({
      model: MODELS.relator,
      system: COMP_SYSTEM,
      messages: [{ role: 'user', content: `Serviço: ${req.category} — ${req.summary}\n\nOrçamentos:\n${list}` }],
      effort: 'low',
      maxTokens: 8000,
    });
    const text = textOf(r.message);
    if (text) postMessage(requestId, 'assistant', text, { kind: 'comparison' });
  } catch (err) {
    console.warn('[relator] resumo falhou', err);
  }
}

// ---------- ações do cliente ----------
export class FlowError extends Error {
  constructor(message: string, public httpStatus = 400) {
    super(message);
  }
}

/** Avisa o prestador que o pedido acabou pra ele. Se a oferta nem tinha saído, só cancela o envio. */
function closeOfferFor(rp: RpRow, motivo: string) {
  const prov = getProvider(rp.provider_id);
  const unsent = run("UPDATE wa_outbox SET state = 'blocked', last_error = 'pedido encerrado', updated_at = ? WHERE ref = ? AND state = 'queued'", now(), `rp:${rp.id}`);
  updateRp(rp.id, { status: rp.status === 'fechado' ? 'fechado' : 'dispensado', pending_inbound_json: '[]' });
  if (Number(unsent.changes) > 0 && rp.status === 'contatado') return; // a oferta nem chegou
  if (!prov?.phone_e164) return;
  const req = getRequest(rp.request_id)!;
  try {
    enqueue({
      to: prov.phone_e164,
      template: 'pedido_encerrado',
      vars: { pedido: String(req.id), categoria: req.category ?? 'serviço', motivo },
      ref: `rp:${rp.id}`,
    });
  } catch (e) {
    if (!(e instanceof OutboxError)) throw e;
  }
  promoteNext(rp.provider_id);
}

const openOffers = (requestId: number, exceptRpId = -1) =>
  all<RpRow>(
    `SELECT * FROM request_providers WHERE request_id = ? AND id != ? AND status IN (${OPEN_OFFER.map(() => '?').join(',')})`,
    requestId, exceptRpId, ...OPEN_OFFER,
  );

/** Aprovar = fechar: o prestador recebe nome, telefone e bairro do cliente; o cliente vê o telefone dele. */
export function approve(requestId: number, rpId: number) {
  const rp = getRp(rpId);
  if (!rp || rp.request_id !== requestId) throw new FlowError('Profissional não encontrado', 404);
  if (rp.quote_value_cents == null) throw new FlowError('Esse profissional ainda não mandou orçamento', 409);
  if (!['orcou', 'respondeu', 'pausado'].includes(rp.status)) throw new FlowError(`Não dá pra aprovar nesse estado (${rp.status})`, 409);
  const req = getRequest(requestId)!;
  if (['fechado', 'avaliado', 'cancelado'].includes(req.status)) throw new FlowError('Pedido já encerrado', 409);
  const name = getSetting('user_name').trim();
  const phone = getSetting('user_phone');
  if (!name || !phone) throw new FlowError('Informa teu nome e celular em Configurações: é o que o profissional recebe pra combinar contigo.', 409);
  const prov = getProvider(rp.provider_id)!;

  enqueue({
    to: prov.phone_e164!,
    template: 'orcamento_aprovado',
    vars: {
      pedido: String(req.id),
      valor: reais(rp.quote_value_cents),
      nome_cliente: name.split(/\s+/)[0],
      telefone_cliente: formatBR(phone),
      bairro: req.neighborhood || req.city || '-',
    },
    ref: `rp:${rp.id}`,
  });
  const ts = now();
  updateRp(rpId, { status: 'fechado', last_activity_at: ts });
  setRequestStatus(requestId, 'fechado', {
    closed_at: ts,
    closed_provider_id: rp.provider_id,
    closed_value_cents: rp.quote_value_cents,
  });
  postMessage(
    requestId,
    'assistant',
    `Fechado com ${prov.name} por ${reais(rp.quote_value_cents)}. Mandei teu nome e celular pra ele; o telefone dele é ${prov.phone_e164 ? formatBR(prov.phone_e164) : '-'}. Combinem o horário direto. Depois eu te pergunto como foi.`,
  );
  pushEvent(rpId, `O cliente aprovou este orçamento. O sistema já mandou ao profissional o nome, o telefone e o bairro do cliente (template "orçamento aprovado"). Daqui pra frente eles combinam direto; se o profissional escrever, responde curto e confirma que o contato foi enviado.`);
  for (const o of openOffers(requestId, rpId)) closeOfferFor(o, 'o cliente escolheu outro orçamento');
}

export function reject(requestId: number, rpId: number) {
  const rp = getRp(rpId);
  if (!rp || rp.request_id !== requestId) throw new FlowError('Profissional não encontrado', 404);
  if (['fechado', 'recusado_pelo_usuario', 'dispensado'].includes(rp.status)) return;
  closeOfferFor(rp, 'o cliente decidiu não seguir com este orçamento');
  updateRp(rpId, { status: 'recusado_pelo_usuario', last_activity_at: now() });
  checkExhausted(requestId);
}

export function cancelRequest(requestId: number) {
  const req = getRequest(requestId);
  if (!req) throw new FlowError('Pedido não encontrado', 404);
  if (req.status === 'cancelado') return;
  const n = openOffers(requestId).length;
  for (const o of openOffers(requestId)) closeOfferFor(o, 'o cliente cancelou o pedido');
  for (const o of all<RpRow>("SELECT * FROM request_providers WHERE request_id = ? AND status = 'sugerido'", requestId)) updateRp(o.id, { status: 'excluido' });
  setRequestStatus(requestId, 'cancelado');
  postMessage(requestId, 'system_event', n ? 'Pedido cancelado. Avisei os profissionais que estavam no pedido.' : 'Pedido cancelado.');
}

/** usado pelo admin/testes: quantos pedidos abertos um prestador tem */
export const openCountFor = (providerId: number) =>
  get<{ n: number }>(`SELECT COUNT(*) AS n FROM request_providers WHERE provider_id = ? AND status IN (${OPEN_OFFER.map((s) => `'${s}'`).join(',')})`, providerId)!.n;
