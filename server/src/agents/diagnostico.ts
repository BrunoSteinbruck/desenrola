// F1 — Diagnóstico: conversa curta com o usuário no site até saber profissão + local.
import { randomUUID } from 'node:crypto';
import type { MessageParam, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { bus } from '../events.ts';
import {
  all, get, getRequest, postMessage, run, updateRequest, setRequestStatus, type Card,
} from '../db.ts';
import { clientOfRequest } from '../auth/clients.ts';
import { withLock } from '../lib/lock.ts';
import { nowBR } from '../lib/time.ts';
import { shortTitle } from '../lib/title.ts';
import { friendlyError, runLoop, strictTool, toolInput, type History , MODELS } from './claude.ts';

const AGENT = 'diagnostico';

// system e tools são constantes: byte-idênticos em toda requisição da conversa.
const SYSTEM = `Tu é o Desenrola, um assistente que ajuda pessoas a resolver problemas de casa e serviços (elétrica, encanamento, chaveiro, pintura, montagem de móveis, ar-condicionado, etc.). Depois de entender o problema, o Desenrola avisa profissionais cadastrados da região, que mandam orçamento pelo nosso WhatsApp; o usuário compara e escolhe aqui no site.

Teu trabalho aqui é só o diagnóstico:
- Entende o que é o problema. Nunca pergunta bairro nem cidade: o app cuida do local num passo próprio, depois do diagnóstico.
- Antes de chamar definir_diagnostico, te pergunta: com o que o usuário contou, um profissional já conseguiria dar um valor aproximado?
  - Se SIM (o problema está bem descrito: o que é, o que acontece e onde), chama definir_diagnostico direto, sem perguntar mais nada.
  - Se NÃO (ex.: uma frase só e vaga, tipo "disjuntor desarmando" ou "pia com problema"), faz UMA pergunta, a que mais ajuda o profissional a orçar. Pode juntar duas coisas curtas na mesma pergunta. Ex.: "Desarma quando tu liga algum aparelho específico, tipo o chuveiro, ou do nada? E é o disjuntor geral ou um só?". Depois da resposta, chama definir_diagnostico, mesmo que ainda falte algum detalhe.
  - Nunca pergunta o que o usuário já disse, nem coisas que o profissional resolve na visita.
- No máximo uma pergunta sobre o problema. Não transforma isso num questionário.
- Depois de chamar, diz em uma frase qual profissional ele precisa e pergunta se pode chamar os da região (ex.: "Pra isso tu precisa de um eletricista. Quer que eu chame os da tua região?"). O usuário confirma por um botão.
- Escreve em português do Brasil, tom simples e próximo, pode usar "tu". Respostas curtas, sem listas longas, sem emoji.
- Não dá orçamento nem preço, não promete prazos. Se for algo perigoso (cheiro de gás, fio pegando fogo), orienta a segurança primeiro (desligar o disjuntor, sair do local, ligar pros bombeiros 193).
- Mensagens marcadas como nota do sistema são instruções do app, não do usuário.`;

const TOOLS = [
  strictTool(
    'definir_diagnostico',
    'Registra o diagnóstico do problema e libera a busca de prestadores. Chame assim que souber a profissão.',
    {
      titulo: {
        type: 'string',
        description:
          'Título bem resumido do pedido, no máximo 48 caracteres: primeiro a coisa com problema, depois o defeito em poucas palavras se couber. Ex.: "Liquidificador: acoplamento gasto", "Tomada da cozinha faiscando", "Vazamento na pia".',
      },
      resumo_para_prestador: {
        type: 'string',
        description: 'Descrição objetiva do problema pra mandar ao prestador (2-4 frases). Sem nome, endereço ou telefone do usuário.',
      },
      relato_curto: {
        type: 'string',
        description:
          'O problema em até 180 caracteres, com as palavras e os detalhes que o usuário deu, como ele mesmo contaria pro profissional. Sem ponto final, sem dado pessoal. Ex.: "o disjuntor geral desarma toda vez que ligo o chuveiro, o resto da casa funciona normal".',
      },
      profissao: { type: 'string', description: 'Profissão a buscar, no singular, ex.: "eletricista", "encanador", "chaveiro"' },
      cidade: { type: 'string', description: 'Só se o usuário disse ou se está no contexto. Senão, vazio. Nunca adivinha.' },
      bairro: { type: 'string', description: 'Só se o usuário disse ou se está no contexto. Senão, vazio. Nunca adivinha.' },
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

/**
 * O cliente mudou o endereço padrão: todo pedido que ainda não foi enviado pros profissionais passa a usar o novo,
 * e o diagnóstico fica sabendo (nota no próximo turno). Pedido que já tinha lista de profissionais volta pro passo
 * de procurar, pra buscar no lugar certo. Pedido já enviado não muda (os profissionais já foram avisados).
 */
export function applyNewAddress(clientId: number, city: string, neighborhood: string, firstTime = false) {
  const where = [neighborhood, city].filter(Boolean).join(', ');
  const open = all<{ id: number; status: string; category: string | null }>(
    "SELECT id, status, category FROM requests WHERE client_id = ? AND status IN ('diagnostico', 'sem_prestadores', 'escolhendo')",
    clientId,
  );
  for (const r of open) {
    updateRequest(r.id, { city: city || null, neighborhood: neighborhood || null });
    addDiagnosticoNote(
      r.id,
      `Nota do sistema: o usuário mudou o endereço padrão para ${where}. Daqui pra frente use esse lugar, a menos que ele diga outro na conversa.`,
    );
    if (r.status !== 'diagnostico') {
      run("DELETE FROM request_providers WHERE request_id = ? AND status IN ('sugerido', 'excluido')", r.id);
      setRequestStatus(r.id, 'diagnostico');
    }
    // primeira vez: a pessoa acabou de confirmar no mapa, não precisa de aviso
    if (firstTime) continue;
    postMessage(
      r.id,
      'system_event',
      r.category && r.status !== 'diagnostico'
        ? `Endereço atualizado pra ${where}. Clica de novo em "Ver ${r.category.toLowerCase()} da região" que eu procuro aí.`
        : `Endereço atualizado pra ${where}.`,
    );
  }
  return open.length;
}

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
    const client = clientOfRequest(requestId);
    const name = client?.name ?? '';
    const hood = client?.neighborhood ?? '';
    userContent =
      `Contexto do app:\n- Nome do usuário: ${name || '(não informado)'}\n` +
      (hood
        ? `- Cidade padrão: ${client!.city}\n- Bairro padrão: ${hood}\n- Se a mensagem não citar outro lugar, use o bairro e a cidade padrão.\n`
        : '- Local: ainda não sei; o usuário confirma depois do diagnóstico. Só preenche cidade e bairro se ele disser.\n') +
      `- Agora: ${nowBR()}\n\n` +
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
    const i = toolInput<{ titulo: string; resumo_para_prestador: string; relato_curto: string; profissao: string; cidade: string; bairro: string; urgencia: string }>(b);
    if (!i.profissao) return { content: 'Faltou a profissão.', isError: true };
    // sem lugar salvo, o local só vale depois de confirmado no mapa; o que a pessoa citou só preenche o formulário
    const owner = clientOfRequest(requestId);
    const known = !!owner?.neighborhood;
    if (cur.status === 'escolhendo') run("DELETE FROM request_providers WHERE request_id = ? AND status IN ('sugerido','excluido')", requestId);
    updateRequest(requestId, {
      title: shortTitle(i.titulo),
      summary: i.resumo_para_prestador,
      category: i.profissao,
      city: known ? i.cidade || owner!.city : null,
      neighborhood: known ? i.bairro || owner!.neighborhood : null,
      details_json: JSON.stringify({ urgencia: i.urgencia, relato_curto: i.relato_curto, cidade_citada: i.cidade, bairro_citado: i.bairro }),
    });
    if (cur.status !== 'diagnostico') setRequestStatus(requestId, 'diagnostico');
    diagnosed = { profissao: i.profissao, resumo: i.resumo_para_prestador };
    return {
      content: known
        ? 'Diagnóstico registrado. Agora diga ao usuário, em uma frase, qual profissional ele precisa e pergunte se pode chamar os da região. Ele confirma por um botão.'
        : 'Diagnóstico registrado. Agora diga ao usuário, em uma frase, qual profissional ele precisa e peça pra informar a cidade e o bairro logo abaixo, pra achar os da região.',
    };
  };

  try {
    const res = await runLoop({
      model: MODELS.diagnostico,
      system: SYSTEM,
      tools: TOOLS,
      history: messages,
      effort: 'medium',
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
