// Negociador (V2): o atendente do Desenrola conversa com o prestador pelo número oficial, um agente por pedido×prestador.
// Só roda com a janela de 24h aberta (o prestador escreveu nas últimas 24h); fora dela, quem fala é template (offers/relator).
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { all, getRequest, getRp, now, postMessage, updateRp, type RpRow } from '../db.ts';
import { withLock } from '../lib/lock.ts';
import { hhmmBR, nowBR } from '../lib/time.ts';
import { enqueue, OutboxError } from '../channel/index.ts';
import { windowOpen } from '../channel/store.ts';
import { checkExhausted, createHandoff, notifyClient, promoteNext, setNegotiatorHooks } from '../marketplace/offers.ts';
import { getProviderV2 } from '../marketplace/providers.ts';
import { friendlyError, runLoop, strictTool, toolInput, type History, type LoopOptions, type LoopResult, MODELS } from './claude.ts';
import { onQuote } from './relator.ts';

// constantes: byte-idênticas em toda a conversa
const SYSTEM = `Tu é o atendente do Desenrola, um serviço que pega orçamentos com profissionais (eletricista, encanador etc.) em nome de clientes. Tu conversa pelo WhatsApp oficial do Desenrola com um profissional cadastrado que aceitou ver um pedido. Teu objetivo: passar as informações do pedido e conseguir valor, condições e disponibilidade, pro cliente comparar e escolher.

Como escrever:
- Educado, direto e humano, como um bom atendente. Trata o profissional por "tu" ou "você", seguindo o jeito dele.
- Poucas mensagens e densas: em geral UMA mensagem por resposta (no máximo duas, separadas por uma linha "---"). Nada de vários balões curtos.
- Sem markdown, sem listas longas, sem emoji.
- Fala do cliente na terceira pessoa ("o cliente"). Tu não é o cliente.
- Sempre cita o número do pedido ("Pedido #12"): o profissional pode ter mais de um pedido aberto neste mesmo número.
- Se perguntarem se é robô: diz que sim, é o assistente automático do Desenrola, e que se ele preferir uma pessoa da equipe assume.

O que nunca fazer:
- Inventar qualquer coisa que o cliente não disse (prazo, pressa, horário, valor máximo, detalhes do problema). Se o profissional precisar de algo que não está no pedido, usa perguntar_ao_cliente.
- Passar nome, telefone ou endereço do cliente. Esses dados só vão quando o cliente aprovar um orçamento, e quem manda é o sistema, automaticamente.
- Falar de outros profissionais: nem quantos foram chamados, nem preços, nem o que disseram.
- Fechar preço, marcar visita ou prometer pagamento em nome do cliente. Quem decide é o cliente, no site.
- Negociar de forma agressiva. Pode perguntar uma vez, com educação, se há condição melhor.

Mensagens que tu recebe: [prestador] é o profissional no WhatsApp. [cliente] é o cliente respondendo pelo site (o profissional não vê). [evento] é aviso do sistema.

Primeira mensagem (quando ele tocou em "Posso atender"; quando ele respondeu direto ao aviso, segue a conversa a partir da resposta dele): passa numa mensagem só tudo o que o Desenrola apurou com o cliente: número do pedido, serviço e bairro; o que o cliente contou, com as palavras dele, inclusive as respostas às perguntas que o Desenrola fez; o diagnóstico provável; e pede um valor aproximado (pode ser faixa ou só a visita) e a data em que poderia ir. Ex.: "Pedido #12, eletricista na Cidade Baixa. O cliente contou: 'o chuveiro parou de esquentar, só sai água fria'. Perguntei se o disjuntor estava desarmado e ele disse que está normal. Provavelmente é a resistência. Consegue me passar um valor aproximado e a data em que poderia ir? Se precisar de mais alguma informação, é só perguntar."

Ferramentas:
- registrar_orcamento: quando o profissional passar um valor (mesmo que seja só a visita ou uma faixa). Registra de novo se mudar.
- perguntar_ao_cliente: pra tudo que depende do cliente ou não está no pedido (fotos, voltagem, horário, acesso ao local, aceitar condição).
- marcar_sem_interesse: quando o profissional disser que não atende, não tem agenda ou recusar.
- escalar_para_humano: SÓ quando o profissional pedir pra falar com uma pessoa, estiver irritado ou reclamando, ou trouxer assunto fora do pedido (cadastro, pagamento, problema com o Desenrola). Resposta do cliente, pergunta técnica, orçamento e pergunta se é robô NÃO são motivo: tu mesmo resolve.

Quando chegar uma resposta do [cliente], repassa ao profissional com as palavras do cliente e segue a negociação (ex.: "O cliente respondeu que é 220V. Com isso, consegue me passar o valor?").`;

const TOOLS = [
  strictTool('registrar_orcamento', 'Registra o orçamento do profissional e mostra pro cliente no site.', {
    valor_reais: { type: 'number', description: 'Valor em reais (ex.: 180.5). Se for faixa, o valor mais provável ou o mínimo.' },
    condicoes: { type: 'string', description: 'O que está incluso, se é só visita, peças, forma de pagamento, garantia.' },
    disponibilidade: { type: 'string', description: 'Quando o profissional pode atender, como ele disse.' },
  }),
  strictTool('perguntar_ao_cliente', 'Manda uma pergunta do profissional pro cliente responder no site.', {
    pergunta: { type: 'string', description: 'Pergunta curta e clara pro cliente.' },
  }),
  strictTool('marcar_sem_interesse', 'Marca que o profissional não vai atender esse pedido.', {
    motivo: { type: 'string' },
  }),
  strictTool('escalar_para_humano', 'Passa a conversa pra uma pessoa da equipe do Desenrola (só se o profissional pedir uma pessoa, estiver irritado ou o assunto for fora do pedido). Depois disso tu não responde mais.', {
    motivo: { type: 'string', description: 'Por que precisa de uma pessoa, em uma frase.' },
  }),
];

type PendingFrom = 'prestador' | 'cliente' | 'evento';
interface PendingItem { from: PendingFrom; text: string; at: string }

const DEBOUNCE_MS = Number(process.env.NEGOCIADOR_DEBOUNCE_MS ?? 4000);
/** eventos e respostas do cliente não precisam esperar o prestador terminar de digitar */
const FAST_MS = Math.min(500, DEBOUNCE_MS);
const timers = new Map<number, NodeJS.Timeout>();
/** estados em que o agente ainda fala com o prestador */
const TALKING = ['respondeu', 'orcou', 'fechado'];

// em teste, o modelo pode ser trocado por um roteiro
let loop: (o: LoopOptions) => Promise<LoopResult> = runLoop;
export function setLoopForTests(fn: typeof loop) {
  loop = fn;
}

function getPending(rp: RpRow): PendingItem[] {
  try {
    return JSON.parse(rp.pending_inbound_json) as PendingItem[];
  } catch {
    return [];
  }
}
function addPending(rpId: number, item: PendingItem) {
  const rp = getRp(rpId);
  if (rp) updateRp(rpId, { pending_inbound_json: JSON.stringify([...getPending(rp), item]) });
}
function schedule(rpId: number, delay: number) {
  clearTimeout(timers.get(rpId));
  timers.set(
    rpId,
    setTimeout(() => {
      timers.delete(rpId);
      void processPending(rpId);
    }, delay),
  );
}
const providerPhone = (rp: RpRow) => getProviderV2(rp.provider_id)?.phone_e164 ?? '';

// ---------- entradas ----------

export function onProviderMessage(rpId: number, text: string) {
  addPending(rpId, { from: 'prestador', text, at: now() });
  schedule(rpId, DEBOUNCE_MS);
}

/** Resposta do cliente pelo site. Fora da janela, vai por template e espera o prestador tocar em "Continuar". */
export function pushUserReply(rpId: number, text: string) {
  const rp = getRp(rpId);
  if (!rp) return;
  addPending(rpId, { from: 'cliente', text, at: now() });
  const phone = providerPhone(rp);
  if (windowOpen(phone)) return schedule(rpId, FAST_MS);
  try {
    enqueue({ to: phone, template: 'pergunta_do_cliente', vars: { pedido: String(rp.request_id), resposta: text }, ref: `rp:${rpId}` });
    postMessage(rp.request_id, 'system_event', 'Mandei tua resposta pro profissional. Ele continua quando abrir a mensagem.');
  } catch (e) {
    postMessage(rp.request_id, 'system_event', `Não consegui mandar tua resposta agora: ${(e as Error).message}`, { kind: 'error' });
  }
}

/** Aviso do sistema (aprovação, encerramento, retomada depois de um humano…). */
export function pushEvent(rpId: number, text: string) {
  addPending(rpId, { from: 'evento', text, at: now() });
  schedule(rpId, FAST_MS);
}

function contextFor(rp: RpRow, providerText: string | null): string {
  const req = getRequest(rp.request_id)!;
  const prov = getProviderV2(rp.provider_id)!;
  // o que o cliente escreveu e o que o diagnóstico perguntou (as mensagens do Desenrola com cartão são avisos, não perguntas)
  const talk = all<{ role: string; content: string; card_json: string | null }>(
    "SELECT role, content, card_json FROM messages WHERE request_id = ? AND role IN ('user','assistant') ORDER BY id",
    rp.request_id,
  );
  const cut = talk.findIndex((m) => m.card_json?.includes('"diagnostico"'));
  const conversation = talk
    .filter((m, i) => m.role === 'user' || (!m.card_json && (cut < 0 || i < cut)))
    .map((m) => (m.role === 'user' ? `> Cliente: ${m.content}` : `> Desenrola perguntou: ${m.content}`));
  return (
    `Pedido #${req.id} (dados do sistema, o profissional não vê este bloco):\n` +
    `- Profissional: ${prov.name}\n` +
    `- Serviço: ${req.category}\n` +
    `- Local: bairro ${req.neighborhood ?? '-'}, ${req.city ?? ''}\n` +
    `- Diagnóstico: ${req.summary ?? '-'}\n` +
    `- Agora: ${nowBR()}\n\n` +
    `Conversa do cliente com o Desenrola no site:\n${conversation.join('\n')}\n\n` +
    (providerText
      ? `O profissional recebeu o aviso do pedido, que já tinha o relato do cliente e a pergunta de valor e disponibilidade, e respondeu:\n` +
        `[prestador ${hhmmBR()}]: ${providerText}\n` +
        `Responde a partir do que ele disse. NÃO repete o pedido nem o relato: ele já leu. Se ele passou valor, registra o orçamento.`
      : `O profissional quer orçar este pedido. Escreve agora a primeira mensagem pra ele.`)
  );
}

/** Começa a negociação (chamado quando o prestador aceita ver o pedido). */
export function startNegotiation(rpId: number, providerText: string | null): Promise<void> {
  return withLock(`neg:${rpId}`, async () => {
    const rp = getRp(rpId);
    if (!rp) return;
    const history = JSON.parse(rp.agent_messages_json) as History;
    if (history.length) {
      // já tinha começado (ex.: voltou da fila): só segue a conversa
      if (providerText) addPending(rpId, { from: 'prestador', text: providerText, at: now() });
      addPending(rpId, { from: 'evento', text: 'A conversa com o profissional voltou a este pedido. Retoma citando o número do pedido.', at: now() });
      schedule(rpId, 300);
      return;
    }
    await runAndSend(rp, [{ role: 'user', content: contextFor(rp, providerText) }]);
  });
}

// ---------- turno ----------

export function processPending(rpId: number): Promise<void> {
  return withLock(`neg:${rpId}`, async () => {
    const rp = getRp(rpId);
    if (!rp) return;
    const pending = getPending(rp);
    if (!pending.length) return;
    if (rp.status === 'pausado' || rp.status === 'na_fila') return; // humano na conversa, ou espera a vez: o pendente fica guardado
    if (!TALKING.includes(rp.status)) {
      updateRp(rpId, { pending_inbound_json: '[]' });
      return;
    }
    const history = JSON.parse(rp.agent_messages_json) as History;
    if (!history.length) return; // primeira mensagem ainda não saiu
    if (!windowOpen(providerPhone(rp))) return; // espera o prestador falar (template já foi, se precisava)
    const lines = pending.map((p) => `[${p.from} ${hhmmBR(new Date(p.at))}]${p.from === 'evento' ? '' : ':'} ${p.text}`);
    updateRp(rpId, { pending_inbound_json: '[]' });
    const ok = await runAndSend(rp, [...history, { role: 'user', content: lines.join('\n') }]);
    if (!ok) {
      const cur = getRp(rpId)!;
      updateRp(rpId, { pending_inbound_json: JSON.stringify([...pending, ...getPending(cur)]) });
      return;
    }
    if (getPending(getRp(rpId)!).length) schedule(rpId, 1000);
  });
}

/** Separa a resposta em mensagens ("---"); no máximo 2. */
export function splitMessages(text: string): string[] {
  const parts = text
    .split(/^\s*-{3,}\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 2 ? [parts[0], parts.slice(1).join('\n\n')] : parts;
}

async function runAndSend(rp: RpRow, messages: History): Promise<boolean> {
  const rpId = rp.id;
  let escalated = false;
  try {
    const res = await loop({
      model: MODELS.negociador,
      system: SYSTEM,
      tools: TOOLS,
      history: messages,
      effort: 'medium',
      maxTokens: 16000,
      maxIters: 4,
      handleTool: async (b) => {
        if (b.name === 'escalar_para_humano') escalated = true;
        return handleTool(rpId, b);
      },
    });
    updateRp(rpId, { agent_messages_json: JSON.stringify(res.history), last_activity_at: now() });
    const cur = getRp(rpId)!;
    if (cur.status === 'pausado' && !escalated) return true; // humano assumiu no meio do turno
    const phone = providerPhone(cur);
    for (const text of splitMessages(res.texts.join('\n\n'))) {
      try {
        enqueue({ to: phone, text, ref: `rp:${rpId}` });
      } catch (e) {
        if (e instanceof OutboxError) console.warn(`[negociador] não enviado (${e.code}): rp ${rpId}`);
        else throw e;
      }
    }
    return true;
  } catch (err) {
    console.error('[negociador] erro', err);
    postMessage(rp.request_id, 'system_event', `Conversa com ${getProviderV2(rp.provider_id)?.name ?? 'o profissional'}: ${friendlyError(err)}`, { kind: 'error' });
    return false;
  }
}

async function handleTool(rpId: number, b: ToolUseBlock): Promise<{ content: string; isError?: boolean }> {
  const rp = getRp(rpId)!;
  const prov = getProviderV2(rp.provider_id)!;
  switch (b.name) {
    case 'registrar_orcamento': {
      const i = toolInput<{ valor_reais: number; condicoes: string; disponibilidade: string }>(b);
      const cents = Math.round(Number(i.valor_reais) * 100);
      if (!Number.isFinite(cents) || cents <= 0) return { content: 'Valor inválido.', isError: true };
      updateRp(rpId, {
        quote_value_cents: cents,
        quote_conditions: i.condicoes ?? '',
        quote_availability: i.disponibilidade ?? '',
        ...(rp.status === 'fechado' ? {} : { status: 'orcou' }),
        last_activity_at: now(),
      });
      onQuote(rpId);
      return {
        content:
          'Orçamento registrado e mostrado ao cliente. Agradece e explica, numa frase, que o cliente vai comparar e que, se ele aprovar, o Desenrola manda o contato do cliente por aqui. Não comenta chance de aprovação.',
      };
    }
    case 'perguntar_ao_cliente': {
      const i = toolInput<{ pergunta: string }>(b);
      postMessage(rp.request_id, 'assistant', `${prov.name} perguntou: ${i.pergunta}`, { kind: 'decision', rpId, pergunta: i.pergunta });
      const req = getRequest(rp.request_id)!;
      notifyClient(req.id, 'cliente_pergunta_prestador', { titulo: req.title ?? req.category ?? 'teu pedido', pergunta: i.pergunta }, `ask:${rpId}`);
      return { content: 'Pergunta enviada ao cliente; a resposta chega como [cliente]. Diz ao profissional que já perguntou e que avisa assim que o cliente responder.' };
    }
    case 'marcar_sem_interesse': {
      const i = toolInput<{ motivo: string }>(b);
      updateRp(rpId, { status: 'recusou', last_activity_at: now() });
      postMessage(rp.request_id, 'system_event', `${prov.name} não vai poder atender${i.motivo ? `: ${i.motivo}` : '.'}`);
      promoteNext(rp.provider_id);
      checkExhausted(rp.request_id);
      return { content: 'Registrado. Agradece com educação, diz que avisa dos próximos pedidos e encerra.' };
    }
    case 'escalar_para_humano': {
      const i = toolInput<{ motivo: string }>(b);
      createHandoff(prov.phone_e164!, prov.id, rpId, `${prov.name} (pedido #${rp.request_id}): ${i.motivo}`);
      return { content: 'Uma pessoa da equipe vai assumir. Diz ao profissional, numa frase, que alguém da equipe do Desenrola responde em breve. Não escreve mais nada depois.' };
    }
  }
  return { content: 'Ferramenta desconhecida.', isError: true };
}

// ---------- ligação com o marketplace e recuperação ----------

setNegotiatorHooks({
  start: (rpId, text) => void startNegotiation(rpId, text),
  providerMessage: onProviderMessage,
  event: pushEvent,
  clientReply: pushUserReply,
});

export function recoverNegotiations() {
  for (const rp of all<RpRow>("SELECT * FROM request_providers WHERE pending_inbound_json != '[]'")) schedule(rp.id, 2000);
  // aceitou mas a primeira mensagem não saiu (caiu no meio)
  for (const rp of all<RpRow>("SELECT * FROM request_providers WHERE status = 'respondeu' AND agent_messages_json = '[]'")) void startNegotiation(rp.id, null);
}
