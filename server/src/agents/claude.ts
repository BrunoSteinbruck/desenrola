// Cliente Claude + regras comuns a todos os funcionários.
// - modelo por agente (MODELS), thinking adaptativo (omitido), effort explícito por agente
// - tools sempre strict + tool_choice auto (any/tool dão 400 nesses modelos)
// - histórico append-only: o content do assistente é guardado intacto (thinking incluído)
// - Sonnet usa o fallback do servidor ("default"): se recusar por engano, outro modelo responde
import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock, Message, MessageParam, ToolUnion, ToolUseBlock, ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';

export type ModelId = 'claude-sonnet-5-5' | 'claude-haiku-5-5' | 'claude-opus-5-5';

/** Qual modelo cada funcionário usa. Diagnóstico e busca precisam de mais conhecimento; conversa é Haiku. */
export const MODELS = {
  diagnostico: 'claude-sonnet-5-5',
  busca: 'claude-sonnet-5-5',
  negociador: 'claude-haiku-5-5',
  relator: 'claude-haiku-5-5',
  geo: 'claude-haiku-5-5',
} as const satisfies Record<string, ModelId>;

export type Effort = 'low' | 'medium';
export type History = MessageParam[];

let client: Anthropic | null = null;
export function hasClaude(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

/** Erro "amigável" pra mostrar no chat. */
export class AgentError extends Error {
  constructor(public userMessage: string, public cause?: unknown) {
    super(userMessage);
  }
}

export function friendlyError(err: unknown): string {
  if (err instanceof AgentError) return err.userMessage;
  if (err instanceof Anthropic.AuthenticationError) return 'A chave da Anthropic (ANTHROPIC_API_KEY) é inválida. Confere o .env e reinicia o servidor.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'A chave da Anthropic não tem permissão pra usar esse modelo.';
  if (err instanceof Anthropic.RateLimitError) return 'A IA está com limite de uso estourado agora. Tenta de novo em um minuto.';
  if (err instanceof Anthropic.InternalServerError) return 'A IA está instável no momento. Tenta de novo em instantes.';
  if (err instanceof Anthropic.APIConnectionError) return 'Não consegui falar com a IA (sem conexão). Confere a internet e tenta de novo.';
  if (err instanceof Anthropic.BadRequestError) return 'A IA recusou a requisição (erro 400). Detalhe registrado no log do servidor.';
  if (err instanceof Anthropic.APIError) return `Erro da IA (${err.status ?? '?'}). Tenta de novo.`;
  return 'Deu um erro inesperado falando com a IA. Tenta de novo.';
}

export const MISSING_KEY_MSG =
  'Não consigo pensar sem a chave da Anthropic: falta configurar ANTHROPIC_API_KEY no arquivo .env. Coloca a chave e reinicia o servidor.';

// ---------- consumo ----------
/** US$ por milhão de tokens (Haiku: preço até 100 mil tokens por chamada); busca na web: US$ 10 a cada mil. */
const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};
const SEARCH_USD = 0.01;
export interface UsageEvent { at: string; model: string; input: number; output: number; cacheWrite: number; cacheRead: number; searches: number; usd: number }
export const usageEvents: UsageEvent[] = [];

function recordUsage(m: Message, requested: ModelId) {
  const u = m.usage;
  // o modelo que respondeu (pode ser outro se houve fallback)
  const model = PRICES[m.model] ? m.model : requested;
  const PRICE = PRICES[model];
  const ev: UsageEvent = {
    at: new Date().toISOString(),
    model,
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    searches: u.server_tool_use?.web_search_requests ?? 0,
    usd: 0,
  };
  ev.usd =
    (ev.input * PRICE.input + ev.output * PRICE.output + ev.cacheWrite * PRICE.cacheWrite + ev.cacheRead * PRICE.cacheRead) / 1e6 +
    ev.searches * SEARCH_USD;
  usageEvents.push(ev);
  console.log(
    `[claude] ${model.replace('claude-', '')} tokens entrada=${ev.input} saída=${ev.output} cache=${ev.cacheRead}/${ev.cacheWrite} buscas=${ev.searches} ≈ US$ ${ev.usd.toFixed(4)}`,
  );
}

export interface TurnOptions {
  model: ModelId;
  system: string;
  tools?: ToolUnion[];
  messages: History;
  effort: Effort;
  maxTokens: number;
  format?: { type: 'json_schema'; schema: Record<string, unknown> };
  /** recebe cada pedaço de texto (só usado no F1) */
  onText?: (delta: string) => void;
}

export interface TurnResult {
  message: Message;
  /** turnos do assistente produzidos (mais de um quando houve pause_turn) — anexar ao histórico nessa ordem */
  appended: MessageParam[];
}

/**
 * Uma chamada ao modelo com streaming. Trata pause_turn (server tools) re-enviando,
 * e stop_reason refusal/max_tokens. Nunca modifica `messages`.
 */
export async function runTurn(opts: TurnOptions): Promise<TurnResult> {
  if (!hasClaude()) throw new AgentError(MISSING_KEY_MSG);
  const appended: MessageParam[] = [];
  for (let i = 0; i < 5; i++) {
    const params = {
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [...opts.messages, ...appended],
      ...(opts.tools?.length ? { tools: opts.tools, tool_choice: { type: 'auto' as const } } : {}),
      output_config: { effort: opts.effort, ...(opts.format ? { format: opts.format } : {}) },
    };
    const onText = (delta: string) => opts.onText?.(delta);
    let message: Message;
    if (opts.model === 'claude-sonnet-5-5') {
      const s = getClient().beta.messages.stream({
        ...params,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      } as Anthropic.Beta.Messages.MessageCreateParamsStreaming);
      if (opts.onText) s.on('text', onText);
      message = (await s.finalMessage()) as unknown as Message;
    } else {
      const s = getClient().messages.stream(params);
      if (opts.onText) s.on('text', onText);
      message = await s.finalMessage();
    }
    recordUsage(message, opts.model);

    if (message.stop_reason === 'refusal') {
      console.warn('[claude] refusal', message.stop_details ?? '');
      throw new AgentError('Não consegui ajudar com esse pedido. Tenta descrever o problema de outro jeito.');
    }
    appended.push({ role: 'assistant', content: message.content as MessageParam['content'] });
    if (message.stop_reason === 'pause_turn') continue; // server tool pausou: re-envia como está
    if (message.stop_reason === 'max_tokens') {
      console.warn('[claude] max_tokens atingido');
      // se não sobrou nada útil, considera erro
      // tool_use cortado (ou nada útil) deixaria o histórico inválido: trata como erro
      if (toolUses(message).length || !textOf(message)) {
        throw new AgentError('A resposta da IA ficou longa demais e foi cortada. Tenta de novo.');
      }
    }
    return { message, appended };
  }
  throw new AgentError('A busca da IA demorou demais. Tenta de novo.');
}

export function textOf(m: { content: ContentBlock[] }): string {
  return m.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

export function toolUses(m: { content: ContentBlock[] }): ToolUseBlock[] {
  return m.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

/** Tool cliente com strict: true. O schema precisa de additionalProperties:false e required completo. */
export function strictTool(name: string, description: string, properties: Record<string, unknown>): ToolUnion {
  return {
    name,
    description,
    strict: true,
    input_schema: {
      type: 'object',
      properties: properties as Record<string, unknown>,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  } as ToolUnion;
}

export function toolResult(id: string, content: string, isError = false): ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) };
}

/** Lê input de tool com segurança (o SDK já entrega objeto; aceita string JSON por garantia). */
export function toolInput<T>(b: ToolUseBlock): T {
  const raw = b.input as unknown;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as T; } catch { return {} as T; }
  }
  return (raw ?? {}) as T;
}

/** Último turno do histórico é do assistente com tool_use pendente? Devolve os ids. */
export function danglingToolUses(history: History): string[] {
  const last = history[history.length - 1];
  if (!last || last.role !== 'assistant' || typeof last.content === 'string') return [];
  return (last.content as Array<{ type: string; id?: string }>).filter((b) => b.type === 'tool_use').map((b) => b.id!);
}

export interface LoopOptions extends Omit<TurnOptions, 'messages'> {
  history: History;
  /** executa uma tool cliente e devolve o conteúdo do tool_result */
  handleTool: (b: ToolUseBlock) => Promise<{ content: string; isError?: boolean }>;
  maxIters?: number;
}
export interface LoopResult {
  /** histórico completo (o recebido + tudo anexado), sempre terminando num turno do assistente sem tool_use pendente */
  history: History;
  /** texto de cada resposta do assistente, na ordem */
  texts: string[];
  toolNames: string[];
  last: Message;
}

/** Loop de tools: chama, executa tools, devolve tool_results, até o modelo encerrar o turno. */
export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  let history = [...opts.history];
  const texts: string[] = [];
  const toolNames: string[] = [];
  const maxIters = opts.maxIters ?? 4;
  for (let i = 0; ; i++) {
    const { message, appended } = await runTurn({ ...opts, messages: history });
    history = [...history, ...appended];
    const t = textOf(message);
    if (t) texts.push(t);
    const uses = toolUses(message);
    if (!uses.length || message.stop_reason !== 'tool_use') return { history, texts, toolNames, last: message };
    const results: ToolResultBlockParam[] = [];
    for (const u of uses) {
      toolNames.push(u.name);
      try {
        const r = await opts.handleTool(u);
        results.push(toolResult(u.id, r.content, r.isError));
      } catch (err) {
        console.error('[claude] tool falhou', u.name, err);
        results.push(toolResult(u.id, 'Erro interno ao executar a ferramenta.', true));
      }
    }
    history = [...history, { role: 'user', content: results }];
    if (i + 1 >= maxIters) {
      // fecha o turno sem deixar tool_result órfão: uma última chamada; se ainda pedir tool, encerra com erro
      const { message: m2, appended: a2 } = await runTurn({ ...opts, messages: history });
      history = [...history, ...a2];
      const t2 = textOf(m2);
      if (t2) texts.push(t2);
      if (toolUses(m2).length) {
        // devolve erro para todas e não chama de novo — o próximo turno do usuário vai junto com esses tool_results
        throw new AgentError('O agente entrou em loop de ferramentas. Tenta de novo.');
      }
      return { history, texts, toolNames, last: m2 };
    }
  }
}
