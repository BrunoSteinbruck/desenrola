// Cliente da API + tipos do contrato (ver API.md).

export type RequestSummary = { id: number; title: string | null; status: string; updated_at: string };

export type Card =
  | { kind: 'diagnostico'; profissao: string; resumo: string }
  | { kind: 'providers' }
  | { kind: 'whatsapp' }
  | { kind: 'payment'; paymentId: number }
  | { kind: 'progress' }
  | { kind: 'quote'; rpId: number }
  | { kind: 'decision'; rpId: number; pergunta: string }
  | { kind: 'paused'; rpId: number }
  | { kind: 'rating'; providerId: number; providerName: string }
  | { kind: 'comparison' }
  | { kind: 'error' };

export type Message = {
  id: number | string;
  role: 'user' | 'assistant' | 'system_event';
  content: string;
  card: Card | null;
  created_at: string;
  streamId?: string;
  streaming?: boolean;
};

export type RequestProvider = {
  id: number;
  provider_id: number;
  name: string;
  phone_display: string;
  rating_google: number | null;
  reviews_google: number | null;
  /** Nota dada pelos nossos usuários (null se ninguém avaliou ainda) */
  our_rating_avg: number | null;
  our_rating_count: number;
  address: string | null;
  selected: boolean;
  status: string;
  quote_value_cents: number | null;
  quote_conditions: string | null;
  quote_availability: string | null;
  last_activity_at: string | null;
};

export type Payment = {
  id: number;
  provider: 'mercadopago' | 'simulado';
  status: string;
  amount_cents: number;
  qr_code: string | null;
  qr_base64: string | null;
  ticket_url: string | null;
  expires_at: string | null;
};

export type RequestDetail = {
  request: {
    id: number;
    title: string | null;
    status: string;
    summary: string | null;
    category: string | null;
    city: string | null;
    neighborhood: string | null;
    scheduled_for: string | null;
    closed_provider_id: number | null;
    closed_value_cents: number | null;
    created_at: string;
    updated_at: string;
  };
  messages: Message[];
  providers: RequestProvider[];
  payment: Payment | null;
};

export type WaState = {
  status: 'desconectado' | 'qr' | 'conectando' | 'conectado';
  qr: string | null;
  me: string | null;
  warning_seen?: boolean;
};

export type Settings = {
  user_name: string;
  user_email: string;
  user_city: string;
  user_neighborhood: string;
  onboarding_done: boolean;
  price_per_request: number;
  credits: number;
  wa_warning_seen: boolean;
};

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.error ?? `Erro ${res.status}`, res.status, data?.code);
  return data as T;
}

export const api = {
  listRequests: () => call<RequestSummary[]>('GET', '/requests'),
  createRequest: (text: string) => call<{ id: number }>('POST', '/requests', { text }),
  getRequest: (id: number) => call<RequestDetail>('GET', `/requests/${id}`),
  sendMessage: (id: number, text: string, providerId?: number) =>
    call('POST', `/requests/${id}/messages`, { text, providerId }),
  search: (id: number) => call('POST', `/requests/${id}/search`),
  toggleProvider: (id: number, rpId: number, selected: boolean) =>
    call('POST', `/requests/${id}/providers/${rpId}`, { selected }),
  dispatch: (id: number) => call('POST', `/requests/${id}/dispatch`),
  cancel: (id: number) => call('POST', `/requests/${id}/cancel`),
  simulatePayment: (paymentId: number) => call('POST', `/payments/${paymentId}/simulate`),
  approve: (id: number, rpId: number) => call('POST', `/requests/${id}/quotes/${rpId}/approve`),
  reject: (id: number, rpId: number) => call('POST', `/requests/${id}/quotes/${rpId}/reject`),
  reply: (id: number, rpId: number, text: string) =>
    call('POST', `/requests/${id}/quotes/${rpId}/reply`, { text }),
  resume: (id: number, rpId: number) => call('POST', `/requests/${id}/providers/${rpId}/resume`),
  rate: (id: number, body: { providerId: number; stars: number; comment: string; serviceDone: boolean }) =>
    call('POST', `/requests/${id}/rating`, body),
  health: () =>
    call<{ claude: boolean; places: boolean; mercadopago: boolean; transcription: boolean; payments: boolean }>('GET', '/health'),
  normalizePlace: (city: string, neighborhood: string) =>
    call<{ city: string; neighborhood: string; found: boolean }>('POST', '/geo/normalize', { city, neighborhood }),
  whatsapp: () => call<WaState>('GET', '/whatsapp'),
  connectWhatsapp: () => call('POST', '/whatsapp/connect'),
  logoutWhatsapp: () => call('POST', '/whatsapp/logout'),
  getSettings: () => call<Settings>('GET', '/settings'),
  putSettings: (s: Partial<Record<keyof Settings, string | boolean>>) => call<Settings>('PUT', '/settings', s),
};

export type StreamEvent =
  | { type: 'message.created'; requestId: number; message: Message }
  | { type: 'message.delta'; requestId: number; messageId: string; text: string }
  | { type: 'message.done'; requestId: number; messageId: string }
  | { type: 'request.updated'; requestId: number }
  | { type: 'requests.changed' }
  | { type: 'wa.status'; status: WaState['status']; qr: string | null; me: string | null }
  | { type: 'payment.updated'; requestId: number; paymentId: number; status: string };

const EVENT_NAMES = [
  'message.created',
  'message.delta',
  'message.done',
  'request.updated',
  'requests.changed',
  'wa.status',
  'payment.updated',
] as const;

/** SSE com reconexão automática. `onReconnect` é chamado quando volta, pra recarregar o estado. */
export function subscribe(onEvent: (e: StreamEvent) => void, onReconnect: () => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let hadError = false;

  const open = () => {
    es = new EventSource('/api/stream');
    es.onopen = () => {
      if (hadError) onReconnect();
      hadError = false;
    };
    const handler = (type: string) => (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data);
        onEvent({ type, ...data } as StreamEvent);
      } catch {
        /* evento malformado: ignora */
      }
    };
    for (const name of EVENT_NAMES) es.addEventListener(name, handler(name));
    // Servidores que mandam tudo em `message` com {type,...}
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data?.type) onEvent(data as StreamEvent);
      } catch {
        /* ignora */
      }
    };
    es.onerror = () => {
      hadError = true;
      es?.close();
      if (!closed) retry = setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    es?.close();
  };
}

/** "555185907072@s.whatsapp.net" -> "(51) 98590-7072" (o JID do WhatsApp às vezes vem sem o 9º dígito). */
export function phoneFromJid(jid: string | null | undefined): string {
  const d = (jid ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (!d.startsWith('55') || d.length < 12) return d ? `+${d}` : '';
  const ddd = d.slice(2, 4);
  let local = d.slice(4);
  if (local.length === 8 && /^[6-9]/.test(local)) local = `9${local}`;
  return local.length === 9 ? `(${ddd}) ${local.slice(0, 5)}-${local.slice(5)}` : `(${ddd}) ${local.slice(0, 4)}-${local.slice(4)}`;
}

export const brl =(cents: number | null | undefined) =>
  cents == null ? '' : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: cents % 100 ? 2 : 0 });

export const STATUS_LABEL: Record<string, string> = {
  diagnostico: 'Entendendo o problema',
  buscando: 'Procurando profissionais',
  escolhendo: 'Escolhendo profissionais',
  pagamento: 'Aguardando pagamento',
  contatando: 'Falando com os profissionais',
  orcamentos: 'Orçamentos recebidos',
  aguardando_confirmacao: 'Confirmando',
  fechado: 'Fechado',
  avaliado: 'Concluído',
  cancelado: 'Cancelado',
  sem_prestadores: 'Ninguém encontrado',
};

export const PROVIDER_STATUS_LABEL: Record<string, string> = {
  sugerido: 'Sugerido',
  excluido: 'Fora',
  na_fila: 'Na fila',
  sem_whatsapp: 'Sem WhatsApp',
  contatado: 'Mensagem enviada',
  respondeu: 'Conversando',
  orcou: 'Mandou orçamento',
  sem_resposta: 'Não respondeu',
  recusou: 'Não pode atender',
  recusado_pelo_usuario: 'Recusado',
  pausado: 'Pausado',
  aprovado: 'Aprovado',
  fechado: 'Fechado',
  dispensado: 'Dispensado',
};
