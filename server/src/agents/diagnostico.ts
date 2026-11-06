// F1 — Diagnóstico: conversa curta com o usuário no site até saber profissão + local.
import { randomUUID } from 'node:crypto';
import type { MessageParam, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { bus } from '../events.ts';
import {
  get, getRequest, getSetting, postMessage, run, updateRequest, setRequestStatus, type Card,
} from '../db.ts';
import { withLock } from '../lib/lock.ts';
import { nowBR } from '../lib/time.ts';
import { friendlyError, runLoop, strictTool, toolInput, type History } from './claude.ts';

const AGENT = 'diagnostico';

// system e tools são constantes: byte-idênticos em toda requisição da conversa.
const SYSTEM = `Tu é o Resolvedor, um assistente que ajuda pessoas a resolver problemas de casa e serviços (elétrica, encanamento, chaveiro, pintura, montagem de móveis, ar-condicionado, etc.). Depois de entender o problema, outro funcionário vai procurar profissionais da região e negociar com eles pelo WhatsApp em nome do usuário.

Teu trabalho aqui é só o diagnóstico:
- Entende o que é o problema, a urgência e o bairro/cidade. Faz no máximo 1 a 3 perguntas curtas, uma de cada vez, e só o que for necessário.
- Se a cidade não for dita, usa a cidade padrão do usuário informada no contexto.
- Assim que souber a profissão certa e o bairro, chama a ferramenta definir_diagnostico. Não espera confirmação pra chamar.
- Depois de chamar, diz em uma frase qual profissional ele precisa e pergunta se pode chamar os da região (ex.: "Pra isso tu precisa de um eletricista. Quer que eu chame os da tua região?"). O usuário confirma por um botão.
- Escreve em português do Brasil, tom simples e próximo, pode usar "tu". Respostas curtas, sem listas longas, sem emoji.
- Não dá orçamento nem preço, não promete prazos. Se for algo perigoso (cheiro de gás, fio pegando fogo), orienta a segurança primeiro (desligar o disjuntor, sair do local, ligar pros bombeiros 193).
- Mensagens marcadas como nota do sistema são instruções do app, não do usuário.`;

const TOOLS = [
  strictTool(
    'definir_diagnostico',
    'Registra o diagnóstico do problema e libera a busca de prestadores. Chame assim que souber a profissão e o bairro.',
    {
      titulo: { type: 'string', description: 'Título curto do pedido, ex.: "Tomada da cozinha sem energia"' },
      resumo_para_prestador: {
        type: 'string',
        description: 'Descrição objetiva do problema pra mandar ao prestador (2-4 frases). Sem nome, endereço ou telefone do usuário.',
      },
      profissao: { type: 'string', description: 'Profissão a buscar, no singular, ex.: "eletricista", "encanador", "chaveiro"' },
      cidade: { type: 'string' },
      bairro: { type: 'string' },
      urgencia: { type: 'string', enum: ['urgente', 'esta_semana', 'sem_pressa'] },
    },
  ),
];

interface State { history: History; pendingTexts: string[]; notes: string[] }

function loadState(requestId: number): State {
  const r = get<{ messages_json: string; pending_json: string }>(
    'SELECT messages_json, pending_json FROM agent_state WHERE request_id = ? AND agent = ?', requestId, AGENT,
  );
  const pending = r ? JSON.parse(r.pending_json) : {};
  return {
    history: r ? JSON.parse(r.messages_json) : [],
    pendingTexts: Array.isArray(pending.texts) ? pending.texts : [],
    notes: Array.isArray(pending.notes) ? pending.notes : [],
  };
}
function saveState(requestId: number, s: State) {
  run(
    `INSERT INTO agent_state (request_id, agent, messages_json, pending_json) VALUES (?, ?, ?, ?)
     ON CONFLICT(request_id, agent) DO UPDATE SET messages_json = excluded.messages_json, pending_json = excluded.pending_json`,
    requestId, AGENT, JSON.stringify(s.history), JSON.stringify({ texts: s.pendingTexts, notes: s.notes }),
  );
}

/** Nota do app pro F1 — entra como turno system logo depois da próxima mensagem do usuário. */
export function addDiagnosticoNote(requestId: number, note: string) {
  const s = loadState(requestId);
  s.notes.push(note);
  saveState(requestId, s);
}

const EDITABLE = new Set(['diagnostico', 'sem_prestadores', 'escolhendo']);

export function runDiagnostico(requestId: number, userText: string): Promise<void> {
  return withLock(`f1:${requestId}`, () => turn(requestId, userText));
}

async function turn(requestId: number, userText: string) {
  const req = getRequest(requestId);
  if (!req) return;
  const state = loadState(requestId);
  const texts = [...state.pendingTexts, userText];

  let userContent: string;
  if (state.history.length === 0) {
    const name = getSetting('user_name');
    const city = getSetting('user_city') || 'Porto Alegre';
    userContent =
      `Contexto do app:\n- Nome do usuário: ${name || '(não informado)'}\n- Cidade padrão: ${city}\n- Agora: ${nowBR()}\n\n` +
      `Mensagem do usuário:\n${texts.join('\n')}`;
  } else {
    userContent = texts.join('\n');
  }
  const messages: MessageParam[] = [...state.history, { role: 'user', content: userContent }];

  // notas do sistema (só depois de um turno user)
  const notes = [...state.notes];
  const assistantTurns = state.history.filter((m) => m.role === 'assistant').length;
  if (!req.category && assistantTurns >= 4) notes.push('Nota do sistema: já foram várias trocas. Chame definir_diagnostico agora com o que tu tem.');
  if (!EDITABLE.has(req.status)) {
    notes.push(`Nota do sistema: o pedido já está em andamento (etapa: ${req.status}). Não chame definir_diagnostico; só responda dúvidas em poucas palavras. Respostas pros prestadores são enviadas pelos botões dos cartões.`);
  }
  if (notes.length) messages.push({ role: 'system', content: notes.join('\n') });

  const streamId = `stream-${randomUUID()}`;
  let diagnosed: { profissao: string; resumo: string } | null = null;

  const handleTool = async (b: ToolUseBlock) => {
    if (b.name !== 'definir_diagnostico') return { content: 'Ferramenta desconhecida.', isError: true };
    const cur = getRequest(requestId)!;
    if (!EDITABLE.has(cur.status)) return { content: 'O pedido já está em andamento; o diagnóstico não pode mais mudar.', isError: true };
    const i = toolInput<{ titulo: string; resumo_para_prestador: string; profissao: string; cidade: string; bairro: string; urgencia: string }>(b);
    if (!i.profissao || !i.bairro) return { content: 'Faltou profissão ou bairro.', isError: true };
    if (cur.status === 'escolhendo') run("DELETE FROM request_providers WHERE request_id = ? AND status IN ('sugerido','excluido')", requestId);
    updateRequest(requestId, {
      title: i.titulo || null,
      summary: i.resumo_para_prestador,
      category: i.profissao,
      city: i.cidade || getSetting('user_city') || 'Porto Alegre',
      neighborhood: i.bairro,
      details_json: JSON.stringify({ urgencia: i.urgencia }),
    });
    if (cur.status !== 'diagnostico') setRequestStatus(requestId, 'diagnostico');
    diagnosed = { profissao: i.profissao, resumo: i.resumo_para_prestador };
    return { content: 'Diagnóstico registrado. Agora diga ao usuário, em uma frase, qual profissional ele precisa e pergunte se pode chamar os da região. Ele confirma por um botão.' };
  };

  try {
    const res = await runLoop({
      system: SYSTEM,
      tools: TOOLS,
      history: messages,
      effort: 'low',
      maxTokens: 8000,
      handleTool,
      maxIters: 2,
      onText: (text) => bus.publish({ type: 'message.delta', requestId, messageId: streamId, text }),
    });
    saveState(requestId, { history: res.history, pendingTexts: [], notes: [] });
    const d = diagnosed as { profissao: string; resumo: string } | null;
    let content = res.texts.join('\n\n');
    if (!content && d) content = `Pra isso tu precisa de um ${d.profissao}. Quer que eu chame os da tua região?`;
    const card: Card | null = d ? { kind: 'diagnostico', profissao: d.profissao, resumo: d.resumo } : null;
    postMessage(requestId, 'assistant', content || '…', card, streamId);
  } catch (err) {
    console.error('[F1] erro', err);
    // guarda o texto do usuário pra próxima tentativa (nada foi anexado ao histórico)
    saveState(requestId, { history: state.history, pendingTexts: texts, notes: state.notes });
    postMessage(requestId, 'system_event', friendlyError(err), { kind: 'error' }, streamId);
  } finally {
    bus.publish({ type: 'message.done', requestId, messageId: streamId });
  }
}
