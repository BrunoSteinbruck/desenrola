// SQLite (node:sqlite) — schema, helpers e "views" no formato do contrato da API.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { bus } from './events.ts';
import { formatBR } from './services/phone.ts';
import { shortTitle } from './lib/title.ts';

// em produção (Render) aponta pro disco persistente
export const DATA_DIR = resolve(process.env.DATA_DIR || resolve(process.cwd(), 'data'));
mkdirSync(DATA_DIR, { recursive: true });

// o projeto se chamava Resolvedor: aproveita o banco antigo se ainda tiver o nome velho
const DB_FILE = resolve(DATA_DIR, 'desenrola.db');
const OLD_DB = resolve(DATA_DIR, 'resolvedor.db');
if (!existsSync(DB_FILE) && existsSync(OLD_DB)) {
  for (const ext of ['', '-wal', '-shm']) if (existsSync(OLD_DB + ext)) renameSync(OLD_DB + ext, DB_FILE + ext);
}

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT, summary TEXT, category TEXT, city TEXT, neighborhood TEXT,
  details_json TEXT,
  status TEXT NOT NULL DEFAULT 'diagnostico',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  scheduled_for TEXT, closed_at TEXT, closed_provider_id INTEGER, closed_value_cents INTEGER,
  followup_sent_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', card_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_req ON messages(request_id);

CREATE TABLE IF NOT EXISTS agent_state (
  request_id INTEGER NOT NULL, agent TEXT NOT NULL,
  messages_json TEXT NOT NULL DEFAULT '[]',
  pending_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (request_id, agent)
);

CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, phone_e164 TEXT, wa_jid TEXT, wa_lid TEXT,
  source TEXT NOT NULL, place_id TEXT,
  rating_google REAL, reviews_google INTEGER, address TEXT, website TEXT,
  our_rating_avg REAL, our_rating_count INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS providers_place ON providers(place_id);
CREATE INDEX IF NOT EXISTS providers_phone ON providers(phone_e164);
CREATE INDEX IF NOT EXISTS providers_jid ON providers(wa_jid);
CREATE INDEX IF NOT EXISTS providers_lid ON providers(wa_lid);

CREATE TABLE IF NOT EXISTS request_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  position INTEGER NOT NULL DEFAULT 0,
  selected INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'sugerido',
  quote_value_cents INTEGER, quote_conditions TEXT, quote_availability TEXT,
  agent_messages_json TEXT NOT NULL DEFAULT '[]',
  last_activity_at TEXT, last_inbound_at TEXT, reminder_sent_at TEXT, call_reply_sent_at TEXT, paused_from TEXT,
  pending_inbound_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (request_id, provider_id)
);

CREATE TABLE IF NOT EXISTS wa_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_provider_id INTEGER,
  direction TEXT NOT NULL,
  wa_message_id TEXT NOT NULL UNIQUE,
  body TEXT, media_type TEXT, transcript TEXT, proto_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_provider_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  not_before TEXT NOT NULL,
  sent_at TEXT, wa_message_id TEXT, failed_at TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  provider TEXT NOT NULL, external_id TEXT, idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  qr_code TEXT, qr_base64 TEXT, ticket_url TEXT, expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL, provider_id INTEGER NOT NULL,
  stars INTEGER NOT NULL, comment TEXT, service_done INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Banco próprio: em que profissão/cidade/bairro cada prestador já apareceu numa busca.
-- Com o uso, a busca passa a vir primeiro daqui (ver agents/buscador.ts).
CREATE TABLE IF NOT EXISTS provider_areas (
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  category_key TEXT NOT NULL,
  category TEXT NOT NULL,
  city_key TEXT NOT NULL,
  city TEXT NOT NULL,
  neighborhood TEXT,
  times_found INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, category_key, city_key)
);
CREATE INDEX IF NOT EXISTS provider_areas_lookup ON provider_areas (category_key, city_key);
`);

/** Chave pra comparar profissão/cidade: minúsculo, sem acento, espaços normalizados. */
export function areaKey(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Prestadores achados antes de existir provider_areas: entram no banco próprio a partir dos pedidos antigos.
{
  const old = db
    .prepare(
      `SELECT DISTINCT rp.provider_id, r.category, r.city, r.neighborhood, r.created_at
         FROM request_providers rp JOIN requests r ON r.id = rp.request_id JOIN providers p ON p.id = rp.provider_id
        WHERE r.category IS NOT NULL AND r.city IS NOT NULL AND p.source != 'teste'
          AND NOT EXISTS (SELECT 1 FROM provider_areas a WHERE a.provider_id = rp.provider_id)`,
    )
    .all() as Array<{ provider_id: number; category: string; city: string; neighborhood: string | null; created_at: string }>;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO provider_areas (provider_id, category_key, category, city_key, city, neighborhood, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const o of old) ins.run(o.provider_id, areaKey(o.category), o.category, areaKey(o.city), o.city, o.neighborhood, o.created_at, o.created_at);
}

// ---------- helpers ----------
type Row = Record<string, any>;
export const now = () => new Date().toISOString();

export function get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).run(...params);
}

// ---------- settings ----------
const SETTING_DEFAULTS: Record<string, string> = {
  user_name: '',
  user_email: '',
  user_city: 'Porto Alegre',
  user_neighborhood: '',
  onboarding_done: '0',
  user_phone: '',
};
export function getSetting(key: string): string {
  const r = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  return r?.value ?? SETTING_DEFAULTS[key] ?? '';
}
export function setSetting(key: string, value: string) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}
export function publicSettings() {
  return {
    user_name: getSetting('user_name'),
    user_email: getSetting('user_email'),
    user_city: getSetting('user_city'),
    user_neighborhood: getSetting('user_neighborhood'),
    onboarding_done: getSetting('onboarding_done') === '1',
    user_phone: getSetting('user_phone'),
  };
}

// ---------- types ----------
export type RequestStatus =
  | 'diagnostico' | 'buscando' | 'escolhendo' | 'pagamento' | 'contatando' | 'orcamentos'
  | 'aguardando_confirmacao' | 'fechado' | 'avaliado' | 'cancelado' | 'sem_prestadores';

export type RpStatus =
  | 'sugerido' | 'excluido' | 'na_fila' | 'sem_whatsapp' | 'contatado' | 'respondeu' | 'orcou'
  | 'sem_resposta' | 'recusou' | 'recusado_pelo_usuario' | 'pausado' | 'aprovado' | 'fechado' | 'dispensado';

/** Estados em que o prestador já foi (ou está sendo) contatado — o WhatsApp dele é "nosso". */
export const CONTACTED: RpStatus[] = [
  'na_fila', 'contatado', 'respondeu', 'orcou', 'sem_resposta', 'recusou', 'recusado_pelo_usuario',
  'pausado', 'aprovado', 'fechado', 'dispensado',
];
/** Estados em que o negociador ainda responde ao prestador. */
export const AGENT_ACTIVE: RpStatus[] = ['na_fila', 'contatado', 'respondeu', 'orcou', 'sem_resposta', 'aprovado', 'fechado'];

export type Card =
  | { kind: 'diagnostico'; profissao: string; resumo: string }
  | { kind: 'providers' }
  | { kind: 'payment'; paymentId: number }
  | { kind: 'progress' }
  | { kind: 'quote'; rpId: number }
  | { kind: 'decision'; rpId: number; pergunta: string }
  | { kind: 'paused'; rpId: number }
  | { kind: 'rating'; providerId: number; providerName: string }
  | { kind: 'comparison' }
  | { kind: 'error' };

export interface RequestRow {
  id: number; title: string | null; summary: string | null; category: string | null;
  city: string | null; neighborhood: string | null; details_json: string | null; status: RequestStatus;
  created_at: string; updated_at: string; scheduled_for: string | null; closed_at: string | null;
  closed_provider_id: number | null; closed_value_cents: number | null; followup_sent_at: string | null;
}
export interface ProviderRow {
  id: number; name: string; phone_e164: string | null; wa_jid: string | null; wa_lid: string | null;
  source: string; place_id: string | null; rating_google: number | null; reviews_google: number | null;
  address: string | null; website: string | null; our_rating_avg: number | null; our_rating_count: number;
  blocked: number;
}
export interface RpRow {
  id: number; request_id: number; provider_id: number; position: number; selected: number; status: RpStatus;
  quote_value_cents: number | null; quote_conditions: string | null; quote_availability: string | null;
  agent_messages_json: string; last_activity_at: string | null; last_inbound_at: string | null;
  reminder_sent_at: string | null; call_reply_sent_at: string | null; paused_from: string | null; pending_inbound_json: string;
  // V2 (colunas criadas em marketplace/providers.ts)
  offered_at?: string | null; viewed_at?: string | null; queued_at?: string | null;
}

export const getRequest = (id: number) => get<RequestRow>('SELECT * FROM requests WHERE id = ?', id);
export const getProvider = (id: number) => get<ProviderRow>('SELECT * FROM providers WHERE id = ?', id);
export const getRp = (id: number) => get<RpRow>('SELECT * FROM request_providers WHERE id = ?', id);

// ---------- mutações com evento ----------
export function setRequestStatus(id: number, status: RequestStatus, extra: Record<string, SQLInputValue> = {}) {
  const cols = Object.keys(extra);
  const sets = ['status = ?', 'updated_at = ?', ...cols.map((c) => `${c} = ?`)].join(', ');
  run(`UPDATE requests SET ${sets} WHERE id = ?`, status, now(), ...cols.map((c) => extra[c]), id);
  touchRequest(id);
}
export function updateRequest(id: number, fields: Record<string, SQLInputValue>) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  run(`UPDATE requests SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => fields[c]), now(), id);
  touchRequest(id);
}
export function touchRequest(id: number) {
  run('UPDATE requests SET updated_at = ? WHERE id = ?', now(), id);
  bus.publish({ type: 'request.updated', requestId: id });
  bus.publish({ type: 'requests.changed' });
}
export function updateRp(rpId: number, fields: Record<string, SQLInputValue>) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  run(`UPDATE request_providers SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => fields[c]), rpId);
  const rp = getRp(rpId);
  if (rp) {
    bus.publish({ type: 'provider.updated', requestId: rp.request_id, rpId });
    bus.publish({ type: 'request.updated', requestId: rp.request_id });
  }
}

export interface ApiMessage {
  id: number; role: 'user' | 'assistant' | 'system_event'; content: string; card: Card | null; created_at: string;
  streamId?: string;
}
function toApiMessage(r: Row): ApiMessage {
  return { id: r.id, role: r.role, content: r.content, card: r.card_json ? JSON.parse(r.card_json) : null, created_at: r.created_at };
}

/** Grava mensagem no chat do site e emite `message.created`. */
export function postMessage(
  requestId: number,
  role: ApiMessage['role'],
  content: string,
  card: Card | null = null,
  streamId?: string,
): ApiMessage {
  const ts = now();
  const res = run(
    'INSERT INTO messages (request_id, role, content, card_json, created_at) VALUES (?, ?, ?, ?, ?)',
    requestId, role, content, card ? JSON.stringify(card) : null, ts,
  );
  const msg: ApiMessage = { id: Number(res.lastInsertRowid), role, content, card, created_at: ts };
  if (streamId) msg.streamId = streamId;
  bus.publish({ type: 'message.created', requestId, message: msg });
  touchRequest(requestId);
  return msg;
}

// ---------- views (contrato da API) ----------
export function listRequestsView() {
  return all<Row>(
    `SELECT r.id, r.title, r.status, r.updated_at,
       (SELECT content FROM messages m WHERE m.request_id = r.id AND m.role = 'user' ORDER BY m.id LIMIT 1) AS first_msg
     FROM requests r ORDER BY r.updated_at DESC, r.id DESC`,
  ).map((r) => ({
    id: r.id,
    title: r.title || shortTitle(r.first_msg ? String(r.first_msg) : null),
    status: r.status,
    updated_at: r.updated_at,
  }));
}

export function paymentView(p: Row | undefined) {
  if (!p) return null;
  return {
    id: p.id, provider: p.provider, status: p.status, amount_cents: p.amount_cents,
    qr_code: p.qr_code ?? null, qr_base64: p.qr_base64 ?? null, ticket_url: p.ticket_url ?? null, expires_at: p.expires_at ?? null,
  };
}

export function providersView(requestId: number) {
  return all<Row>(
    `SELECT rp.*, p.name, p.phone_e164, p.rating_google, p.reviews_google, p.address, p.our_rating_avg, p.our_rating_count
     FROM request_providers rp JOIN providers p ON p.id = rp.provider_id
     WHERE rp.request_id = ? ORDER BY rp.position, rp.id`,
    requestId,
  ).map((r) => ({
    id: r.id,
    provider_id: r.provider_id,
    name: r.name,
    phone_display: r.phone_e164 ? formatBR(r.phone_e164) : null,
    rating_google: r.rating_google ?? null,
    reviews_google: r.reviews_google ?? null,
    our_rating_avg: r.our_rating_count > 0 ? r.our_rating_avg : null,
    our_rating_count: r.our_rating_count ?? 0,
    address: r.address ?? null,
    selected: !!r.selected,
    status: r.status,
    quote_value_cents: r.quote_value_cents ?? null,
    quote_conditions: r.quote_conditions ?? null,
    quote_availability: r.quote_availability ?? null,
    last_activity_at: r.last_activity_at ?? null,
  }));
}

export function requestView(id: number) {
  const r = getRequest(id);
  if (!r) return null;
  const firstMsg = get<{ content: string }>("SELECT content FROM messages WHERE request_id = ? AND role = 'user' ORDER BY id LIMIT 1", id);
  const payment = get<Row>('SELECT * FROM payments WHERE request_id = ? ORDER BY id DESC LIMIT 1', id);
  return {
    request: {
      id: r.id,
      title: r.title || shortTitle(firstMsg?.content),
      status: r.status,
      summary: r.summary,
      category: r.category,
      city: r.city,
      neighborhood: r.neighborhood,
      scheduled_for: r.scheduled_for,
      closed_provider_id: r.closed_provider_id,
      closed_value_cents: r.closed_value_cents,
      created_at: r.created_at,
      updated_at: r.updated_at,
    },
    messages: all<Row>('SELECT * FROM messages WHERE request_id = ? ORDER BY id', id).map(toApiMessage),
    providers: providersView(id),
    payment: paymentView(payment),
  };
}
