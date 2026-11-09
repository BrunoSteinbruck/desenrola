// Cliente das rotas /api/admin (ver server/src/marketplace/admin-routes.ts).

export type ProviderStatus = 'convidado' | 'ativo' | 'pausado' | 'saiu' | 'bloqueado';

export type AdminProvider = {
  id: number;
  name: string;
  phone: string;
  phone_display: string;
  status: ProviderStatus;
  categories: string[];
  regions: { city: string; neighborhood: string | null }[];
  bio: string | null;
  notes: string | null;
  paused_until: string | null;
  opt_in_at: string | null;
  opt_in_text: string | null;
  opt_out_at: string | null;
  our_rating_avg: number | null;
  our_rating_count: number;
  created_at: string;
};

export type ProviderInput = {
  name: string;
  phone: string;
  categories: string | string[];
  city: string;
  /** vazio = cidade toda */
  neighborhoods: string | string[];
  bio?: string | null;
  notes?: string | null;
};

export type InviteResult = { sent: boolean; reason?: string };

export type Handoff = {
  id: number;
  phone: string;
  phone_display: string;
  provider_id: number | null;
  provider_name: string | null;
  rp_id: number | null;
  reason: string | null;
  status: string;
  created_at: string;
  window_open: boolean;
};

export type ConversationSummary = {
  phone: string;
  phone_display: string;
  name: string | null;
  last_at: string;
  window_open: boolean;
  handoff_open: boolean;
};

export type Inbox = { handoffs: Handoff[]; conversations: ConversationSummary[] };

export type ThreadMessage = {
  dir: 'in' | 'out';
  at: string;
  text: string;
  template?: string | null;
  state?: string | null;
  delivery?: string | null;
  error?: string | null;
  ref?: string | null;
};

export type ConversationThread = {
  phone: string;
  phone_display: string;
  window_open: boolean;
  opt_in_at: string | null;
  opt_out_at: string | null;
  messages: ThreadMessage[];
};

export class AdminApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

const OFFLINE = 'O servidor não respondeu. Pode ser uma atualização; tento de novo sozinho.';

export async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/admin${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new AdminApiError(OFFLINE, 0, 'offline');
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; code?: string };
    if (!d.error && res.status >= 500) throw new AdminApiError(OFFLINE, res.status, 'offline');
    throw new AdminApiError(d.error || 'Não consegui fazer isso agora. Tenta de novo.', res.status, d.code);
  }
  return data as T;
}

export const adminApi = {
  me: () => call<{ ok: true }>('GET', '/me'),
  login: (password: string) => call<{ ok: true }>('POST', '/login', { password }),
  logout: () => call<{ ok: true }>('POST', '/logout'),
  providers: () => call<AdminProvider[]>('GET', '/providers'),
  createProvider: (p: ProviderInput) => call<{ id: number; invite: InviteResult }>('POST', '/providers', p),
  updateProvider: (id: number, p: Partial<ProviderInput> & { status?: 'ativo' | 'pausado' | 'bloqueado' }) =>
    call<{ ok: true }>('PUT', `/providers/${id}`, p),
  invite: (id: number) => call<InviteResult>('POST', `/providers/${id}/invite`),
  inbox: () => call<Inbox>('GET', '/inbox'),
  conversation: (phone: string) => call<ConversationThread>('GET', `/conversations/${encodeURIComponent(phone)}`),
  reply: (phone: string, text: string) => call<{ ok: true }>('POST', `/conversations/${encodeURIComponent(phone)}/reply`, { text }),
  closeHandoff: (id: number, resume: boolean) => call<{ ok: true }>('POST', `/handoffs/${id}/close`, { resume }),
};

/** Ouve o SSE e chama os callbacks quando o inbox ou a lista de prestadores mudam. Reconecta sozinho. */
export function subscribeAdmin(handlers: { inbox: () => void; providers: () => void }): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let hadError = false;

  const open = () => {
    es = new EventSource('/api/admin/stream');
    es.onopen = () => {
      if (hadError) {
        handlers.inbox();
        handlers.providers();
      }
      hadError = false;
    };
    es.addEventListener('admin.inbox', () => handlers.inbox());
    es.addEventListener('admin.providers', () => handlers.providers());
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as { type?: string };
        if (data?.type === 'admin.inbox') handlers.inbox();
        else if (data?.type === 'admin.providers') handlers.providers();
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
