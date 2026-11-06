// F5 — Negociador: um agente por prestador, conversando pelo WhatsApp em nome do usuário.
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  AGENT_ACTIVE, all, getProvider, getRequest, getRp, getSetting, now, postMessage, updateRp,
  type RpRow, type RpStatus,
} from '../db.ts';
import { withLock } from '../lib/lock.ts';
import { hhmmBR, nowBR, parseLocalDate } from '../lib/time.ts';
import { enqueue, nextStaggerDelay } from '../whatsapp.ts';
import { friendlyError, runLoop, strictTool, toolInput, type History } from './claude.ts';
import { closeDeal, onQuote } from './relator.ts';

// constantes: byte-idênticas em toda a conversa
const SYSTEM = `Tu é um assistente virtual que conversa pelo WhatsApp com um prestador de serviço em nome de um cliente, pra conseguir orçamento e disponibilidade.

Como funciona a conversa:
- Cada texto que tu escrever é enviado como mensagem de WhatsApp pro prestador. Escreve como uma pessoa escreveria no WhatsApp: curto, natural, educado, português do Brasil, sem markdown, sem listas, sem emoji em excesso. Se não houver nada útil pra dizer ao prestador, não escreve texto nenhum.
- Mensagens que chegam marcadas com [prestador] são do prestador. [usuário] é o cliente falando contigo pelo app (não é visto pelo prestador). [evento] é aviso do app.
- Na primeira mensagem, te apresenta como assistente do cliente (pelo primeiro nome), descreve o problema em poucas palavras e pergunta valor (ou faixa de valor/visita) e disponibilidade.
- Se perguntarem, admite com naturalidade que é um assistente virtual.

Ferramentas:
- registrar_orcamento: quando o prestador passar um valor (mesmo que seja só da visita ou uma faixa). Registra de novo se o valor mudar.
- pedir_decisao_usuario: pra tudo que depende do cliente — aceitar valor, escolher horário, endereço completo, fotos, qualquer dado pessoal. Depois de chamar, avisa o prestador que vai confirmar com o cliente e retorna.
- marcar_sem_interesse: quando o prestador disser que não atende, não tem agenda ou recusar.
- confirmar_fechamento: só depois de um [evento] dizendo que o cliente aprovou o orçamento E de o prestador confirmar dia/horário.

Regras duras:
- Nunca fecha preço nem marca visita sem o cliente aprovar no app.
- Tu não sabe o endereço completo, telefone, e-mail nem documentos do cliente — só o bairro. Nunca inventa esses dados; se pedirem, usa pedir_decisao_usuario. Quando o cliente responder com o dado, aí pode repassar.
- Não negocia de forma agressiva; pode perguntar se há condição melhor uma vez, com educação.
- Não promete pagamento, sinal ou PIX em nome do cliente.`;

const TOOLS = [
  strictTool('registrar_orcamento', 'Registra o orçamento que o prestador passou e mostra pro cliente no app.', {
    valor_reais: { type: 'number', description: 'Valor em reais (ex.: 180.5). Se for faixa, o valor mais provável ou o mínimo.' },
    condicoes: { type: 'string', description: 'O que está incluso, se é só visita, forma de pagamento, garantia etc.' },
    disponibilidade: { type: 'string', description: 'Quando o prestador pode ir, como ele disse.' },
  }),
  strictTool('pedir_decisao_usuario', 'Faz uma pergunta ao cliente no app (decisão, horário, endereço, dado pessoal).', {
    pergunta: { type: 'string', description: 'Pergunta curta e clara pro cliente.' },
  }),
  strictTool('marcar_sem_interesse', 'Marca que o prestador não vai atender (recusou, sem agenda, não faz esse serviço).', {
    motivo: { type: 'string' },
  }),
  strictTool('confirmar_fechamento', 'Fecha o serviço com o prestador. Só funciona se o cliente já aprovou o orçamento no app.', {
    data_servico: { type: 'string', description: 'Data/hora combinada no formato AAAA-MM-DDTHH:MM (horário de Brasília), ou AAAA-MM-DD se só tiver o dia.' },
  }),
];

type PendingFrom = 'prestador' | 'usuario' | 'usuario_whatsapp' | 'evento' | 'nota';
interface PendingItem { from: PendingFrom; text: string; at: string }

const DEBOUNCE_MS = 8000;
const timers = new Map<number, NodeJS.Timeout>();

function getPending(rp: RpRow): PendingItem[] {
  try { return JSON.parse(rp.pending_inbound_json) as PendingItem[]; } catch { return []; }
}

function addPending(rpId: number, item: PendingItem) {
  const rp = getRp(rpId);
  if (!rp) return;
  updateRp(rpId, { pending_inbound_json: JSON.stringify([...getPending(rp), item]) });
}

function schedule(rpId: number, delay: number) {
  const t = timers.get(rpId);
  if (t) clearTimeout(t);
  timers.set(rpId, setTimeout(() => {
    timers.delete(rpId);
    void processPending(rpId);
  }, delay));
}

// ---------- entradas ----------
/** Mensagem do prestador (já gravada em wa_messages). */
export function onProviderMessage(rpId: number, text: string) {
  const rp = getRp(rpId);
  if (!rp) return;
  const ts = now();
  const fields: Record<string, string> = { last_activity_at: ts, last_inbound_at: ts };
  if (rp.status === 'contatado' || rp.status === 'sem_resposta' || rp.status === 'na_fila') fields.status = 'respondeu';
  updateRp(rpId, fields);
  addPending(rpId, { from: 'prestador', text, at: ts });
  schedule(rpId, DEBOUNCE_MS);
}

/** Usuário respondeu à mão pelo celular → pausa o agente desse prestador. */
export function onManualReply(rpId: number, text: string) {
  const rp = getRp(rpId);
  if (!rp) return;
  addPending(rpId, { from: 'usuario_whatsapp', text, at: now() });
  if (rp.status === 'pausado') return;
  updateRp(rpId, { status: 'pausado', paused_from: rp.status, last_activity_at: now() });
  const prov = getProvider(rp.provider_id);
  postMessage(
    rp.request_id,
    'system_event',
    `Vi que tu respondeu o ${prov?.name ?? 'prestador'} direto; parei de falar com ele. Quer que eu retome?`,
    { kind: 'paused', rpId },
  );
}

/** Resposta/instrução do usuário pelo site pra esse negociador. */
export function pushUserReply(rpId: number, text: string) {
  addPending(rpId, { from: 'usuario', text, at: now() });
  schedule(rpId, 500);
}

/** Evento do app (aprovação, recusa, retomada…). */
export function pushEvent(rpId: number, text: string) {
  addPending(rpId, { from: 'evento', text, at: now() });
  schedule(rpId, 500);
}

/** Nota que não dispara turno sozinha (ex.: lembrete enviado pelo scheduler). */
export function pushNote(rpId: number, text: string) {
  addPending(rpId, { from: 'nota', text, at: now() });
}

export function resume(rpId: number) {
  const rp = getRp(rpId);
  if (!rp || rp.status !== 'pausado') return false;
  const back = (rp.paused_from as RpStatus | null) ?? 'respondeu';
  updateRp(rpId, { status: back === 'na_fila' || back === 'contatado' ? 'respondeu' : back, paused_from: null });
  pushEvent(rpId, 'O cliente tinha falado direto com o prestador pelo WhatsApp e agora pediu pra tu retomar a conversa. Leva em conta o que ele escreveu.');
  return true;
}

// ---------- primeira mensagem ----------
export function startNegotiation(rpId: number): Promise<void> {
  return withLock(`f5:${rpId}`, async () => {
    const rp = getRp(rpId);
    if (!rp) return;
    const history = JSON.parse(rp.agent_messages_json) as History;
    if (history.length) return; // já começou
    const req = getRequest(rp.request_id)!;
    const prov = getProvider(rp.provider_id)!;
    const firstName = (getSetting('user_name') || '').trim().split(/\s+/)[0] || '';
    let urg = '';
    try { urg = JSON.parse(req.details_json ?? '{}').urgencia ?? ''; } catch { /* ok */ }
    const ctx =
      `Contexto (do app, não do prestador):\n` +
      `- Cliente: ${firstName || '(sem nome; diga só "um cliente")'}\n` +
      `- Prestador: ${prov.name}\n` +
      `- Serviço: ${req.category}\n` +
      `- Problema: ${req.summary}\n` +
      `- Bairro: ${req.neighborhood ?? '-'}, ${req.city ?? ''}\n` +
      `- Urgência: ${urg || 'não informada'}\n` +
      `- Agora: ${nowBR()}\n\n` +
      `Escreve agora a primeira mensagem pro prestador.`;
    await runAndSend(rp, [...history, { role: 'user', content: ctx }], true);
  });
}

// ---------- turno ----------
export function processPending(rpId: number): Promise<void> {
  return withLock(`f5:${rpId}`, async () => {
    const rp = getRp(rpId);
    if (!rp) return;
    const pending = getPending(rp);
    if (!pending.some((p) => p.from !== 'nota')) return;
    if (rp.status === 'pausado') return; // segura até o usuário retomar
    const hasEvent = pending.some((p) => p.from === 'evento' || p.from === 'usuario');
    if (!AGENT_ACTIVE.includes(rp.status) && !hasEvent) {
      updateRp(rpId, { pending_inbound_json: '[]' }); // prestador encerrado: não responde mais
      return;
    }
    const history = JSON.parse(rp.agent_messages_json) as History;
    if (!history.length) return; // primeira mensagem ainda não saiu; startNegotiation cuida
    const lines = pending.map((p) => {
      const h = hhmmBR(new Date(p.at));
      switch (p.from) {
        case 'prestador': return `[prestador ${h}]: ${p.text}`;
        case 'usuario': return `[usuário ${h}]: ${p.text}`;
        case 'usuario_whatsapp': return `[usuário escreveu direto pro prestador no WhatsApp ${h}]: ${p.text}`;
        case 'evento': return `[evento ${h}] ${p.text}`;
        case 'nota': return `[evento ${h}] ${p.text}`;
      }
    });
    // limpa antes do turno; o que chegar durante o turno fica pra um próximo
    updateRp(rpId, { pending_inbound_json: '[]' });
    const ok = await runAndSend(rp, [...history, { role: 'user', content: lines.join('\n') }], false);
    if (!ok) {
      // devolve as pendências na frente das novas
      const cur = getRp(rpId)!;
      updateRp(rpId, { pending_inbound_json: JSON.stringify([...pending, ...getPending(cur)]) });
      return;
    }
    const after = getRp(rpId)!;
    if (getPending(after).some((p) => p.from !== 'nota')) schedule(rpId, 1000);
  });
}

async function runAndSend(rp: RpRow, messages: History, first: boolean): Promise<boolean> {
  const rpId = rp.id;
  try {
    const res = await runLoop({
      system: SYSTEM,
      tools: TOOLS,
      history: messages,
      effort: 'medium',
      maxTokens: 16000,
      maxIters: 4,
      handleTool: (b) => handleTool(rpId, b),
    });
    updateRp(rpId, { agent_messages_json: JSON.stringify(res.history) });
    const cur = getRp(rpId)!;
    const text = res.texts.join('\n\n').trim();
    if (text && cur.status !== 'pausado') {
      enqueue(rpId, text, first ? nextStaggerDelay() : 1500 + Math.random() * 2500);
    }
    return true;
  } catch (err) {
    console.error('[F5] erro', err);
    postMessage(rp.request_id, 'system_event', `Negociação com ${getProvider(rp.provider_id)?.name ?? 'prestador'}: ${friendlyError(err)}`, { kind: 'error' });
    return false;
  }
}

async function handleTool(rpId: number, b: ToolUseBlock): Promise<{ content: string; isError?: boolean }> {
  const rp = getRp(rpId)!;
  const prov = getProvider(rp.provider_id)!;
  switch (b.name) {
    case 'registrar_orcamento': {
      const i = toolInput<{ valor_reais: number; condicoes: string; disponibilidade: string }>(b);
      const cents = Math.round(Number(i.valor_reais) * 100);
      if (!Number.isFinite(cents) || cents <= 0) return { content: 'Valor inválido.', isError: true };
      const keep = rp.status === 'aprovado' || rp.status === 'fechado';
      updateRp(rpId, {
        quote_value_cents: cents,
        quote_conditions: i.condicoes ?? '',
        quote_availability: i.disponibilidade ?? '',
        ...(keep ? {} : { status: 'orcou' }),
        last_activity_at: now(),
      });
      onQuote(rpId);
      return { content: 'Orçamento registrado e mostrado ao cliente no app. Diz ao prestador que vai passar pro cliente e retorna em breve. Não fecha nada ainda.' };
    }
    case 'pedir_decisao_usuario': {
      const i = toolInput<{ pergunta: string }>(b);
      if (!['aprovado', 'fechado', 'orcou'].includes(rp.status)) updateRp(rpId, { status: 'respondeu' });
      postMessage(rp.request_id, 'assistant', `${prov.name} perguntou: ${i.pergunta}`, { kind: 'decision', rpId, pergunta: i.pergunta });
      return { content: 'Pergunta encaminhada ao cliente; aguardando a resposta, que vai chegar como [usuário]. Se fizer sentido, avisa o prestador que vai confirmar e retorna.' };
    }
    case 'marcar_sem_interesse': {
      const i = toolInput<{ motivo: string }>(b);
      updateRp(rpId, { status: 'recusou', last_activity_at: now() });
      postMessage(rp.request_id, 'system_event', `${prov.name} não vai poder atender${i.motivo ? `: ${i.motivo}` : '.'}`);
      return { content: 'Registrado. Agradece com educação e encerra.' };
    }
    case 'confirmar_fechamento': {
      const i = toolInput<{ data_servico: string }>(b);
      if (rp.status !== 'aprovado') {
        return { content: 'Não pode fechar: o cliente ainda não aprovou esse orçamento no app. Usa pedir_decisao_usuario ou espera o [evento] de aprovação.', isError: true };
      }
      closeDeal(rpId, parseLocalDate(i.data_servico ?? ''));
      return { content: 'Fechamento registrado. Confirma com o prestador o combinado (dia/horário) e agradece.' };
    }
  }
  return { content: 'Ferramenta desconhecida.', isError: true };
}

// ---------- recuperação na subida ----------
export function recoverNegotiations() {
  // pendências que ficaram de antes do restart
  for (const rp of all<RpRow>("SELECT * FROM request_providers WHERE pending_inbound_json != '[]'")) schedule(rp.id, 2000);
  // na fila sem primeira mensagem gerada nem enfileirada
  for (const rp of all<RpRow>(
    `SELECT rp.* FROM request_providers rp WHERE rp.status = 'na_fila' AND rp.agent_messages_json = '[]'
       AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.request_provider_id = rp.id)`,
  )) void startNegotiation(rp.id);
}

