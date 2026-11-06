// Orquestração do disparo: F3 (pagamento/crédito) -> F4 (validação WhatsApp) -> F5 (primeiras mensagens).
import {
  all, get, getProvider, getRequest, getSetting, postMessage, run, setRequestStatus, setSetting, updateRp, type RpRow,
} from './db.ts';
import { activePayment, createPayment, setOnExpired, setOnPaid, type PaymentRow } from './services/payments.ts';
import { checkWhatsApp, connect, isConnected, refreshActiveJids } from './whatsapp.ts';
import { startNegotiation } from './agents/negociador.ts';
import { FlowError } from './agents/relator.ts';

export type DispatchResult =
  | { ok: true; mode: 'free' }
  | { ok: true; mode: 'credit' }
  | { ok: true; mode: 'payment'; payment: PaymentRow };

/** Cobrança ligada? Por enquanto os primeiros usuários usam de graça: só cobra com PAGAMENTO_ATIVO=1 no .env. */
export const paymentsEnabled = () => /^(1|true|sim)$/i.test(process.env.PAGAMENTO_ATIVO ?? '');

export async function dispatch(requestId: number): Promise<DispatchResult> {
  const req = getRequest(requestId);
  if (!req) throw new FlowError('Pedido não encontrado', 404);
  if (req.status !== 'escolhendo' && req.status !== 'pagamento') throw new FlowError(`Não dá pra chamar prestadores nessa etapa (${req.status})`, 409);
  const selected = all<RpRow>("SELECT * FROM request_providers WHERE request_id = ? AND selected = 1 AND status = 'sugerido'", requestId);
  if (!selected.length) throw new FlowError('Seleciona pelo menos um prestador', 400);

  if (!isConnected()) {
    void connect();
    const last = get<{ card_json: string | null }>('SELECT card_json FROM messages WHERE request_id = ? ORDER BY id DESC LIMIT 1', requestId);
    if (!last?.card_json?.includes('"whatsapp"')) {
      postMessage(requestId, 'system_event', 'Pra eu falar com os prestadores, conecta teu WhatsApp lendo o QR code.', { kind: 'whatsapp' });
    }
    const e = new FlowError('WhatsApp não conectado', 409) as FlowError & { code?: string };
    e.code = 'wa_not_connected';
    throw e;
  }

  if (!paymentsEnabled()) {
    // modo grátis: descarta um Pix pendente (de quando a cobrança estava ligada) e já começa
    run("UPDATE payments SET status = 'cancelled' WHERE request_id = ? AND status = 'pending'", requestId);
    void startContacting(requestId);
    return { ok: true, mode: 'free' };
  }

  const existing = activePayment(requestId);
  if (existing) return { ok: true, mode: 'payment', payment: existing };

  const credits = Number(getSetting('credits')) || 0;
  if (credits > 0) {
    setSetting('credits', String(credits - 1));
    postMessage(requestId, 'system_event', `Usei 1 crédito (sobraram ${credits - 1}).`);
    void startContacting(requestId);
    return { ok: true, mode: 'credit' };
  }

  const payment = await createPayment(requestId);
  setRequestStatus(requestId, 'pagamento');
  if (payment.status === 'pending') {
    postMessage(requestId, 'assistant', 'Pra eu chamar os prestadores, paga o Pix abaixo. Assim que cair, começo.', { kind: 'payment', paymentId: payment.id });
  }
  return { ok: true, mode: 'payment', payment };
}

setOnPaid((requestId) => {
  postMessage(requestId, 'system_event', 'Pagamento confirmado.');
  void startContacting(requestId);
});
setOnExpired((requestId) => {
  const req = getRequest(requestId);
  if (req?.status !== 'pagamento') return;
  postMessage(requestId, 'system_event', 'O Pix expirou. Clica em "Chamar selecionados" de novo pra gerar outro.', { kind: 'providers' });
});

const contacting = new Set<number>();

export async function startContacting(requestId: number) {
  if (contacting.has(requestId)) return;
  contacting.add(requestId);
  try {
    const req = getRequest(requestId);
    if (!req || ['cancelado', 'fechado', 'avaliado'].includes(req.status)) return;
    if (req.status !== 'contatando') {
      setRequestStatus(requestId, 'contatando');
      postMessage(requestId, 'system_event', 'Chamando os prestadores. Mando um de cada vez, com intervalo, pra parecer natural.', { kind: 'progress' });
    }
    // não selecionados saem da lista
    for (const rp of all<RpRow>("SELECT * FROM request_providers WHERE request_id = ? AND selected = 0 AND status = 'sugerido'", requestId)) {
      updateRp(rp.id, { status: 'excluido' });
    }
    if (!isConnected()) {
      // retoma quando o WhatsApp conectar (resumeAfterConnect)
      postMessage(requestId, 'system_event', 'O WhatsApp está desconectado; começo assim que reconectar.', { kind: 'whatsapp' });
      return;
    }
    const todo = all<RpRow>("SELECT * FROM request_providers WHERE request_id = ? AND selected = 1 AND status = 'sugerido' ORDER BY position, id", requestId);
    const ready: number[] = [];
    for (const rp of todo) {
      const prov = getProvider(rp.provider_id)!;
      if (!prov.wa_jid) {
        const jid = prov.phone_e164 ? await checkWhatsApp(prov.phone_e164) : null;
        if (jid === undefined) continue; // não deu pra checar agora; tenta no próximo connect
        if (jid === null) {
          updateRp(rp.id, { status: 'sem_whatsapp' });
          postMessage(requestId, 'system_event', `${prov.name} não tem WhatsApp nesse número; pulei.`);
          continue;
        }
        run('UPDATE providers SET wa_jid = ? WHERE id = ?', jid, prov.id);
      }
      updateRp(rp.id, { status: 'na_fila' });
      ready.push(rp.id);
    }
    refreshActiveJids();
    const any = get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM request_providers WHERE request_id = ? AND status NOT IN ('sugerido','excluido','sem_whatsapp')",
      requestId,
    )!.n;
    const waiting = get<{ n: number }>("SELECT COUNT(*) AS n FROM request_providers WHERE request_id = ? AND selected = 1 AND status = 'sugerido'", requestId)!.n;
    if (!any && !waiting) {
      setRequestStatus(requestId, 'sem_prestadores');
      setSetting('credits', String((Number(getSetting('credits')) || 0) + 1));
      postMessage(requestId, 'assistant', 'Nenhum dos selecionados tem WhatsApp. Devolvi o valor como 1 crédito pro próximo pedido. Quer tentar outro bairro?');
      return;
    }
    // gera as primeiras mensagens em paralelo; o escalonamento 20–60s é feito na outbox
    await Promise.all(ready.map((id) => startNegotiation(id)));
  } finally {
    contacting.delete(requestId);
  }
}

/** Ao conectar: retoma pedidos pagos que ficaram esperando o WhatsApp. */
export function resumeAfterConnect() {
  for (const r of all<{ id: number }>(
    `SELECT DISTINCT r.id FROM requests r JOIN request_providers rp ON rp.request_id = r.id
     WHERE r.status = 'contatando' AND rp.selected = 1 AND rp.status = 'sugerido'`,
  )) void startContacting(r.id);
}
