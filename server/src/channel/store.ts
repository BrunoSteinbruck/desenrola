// Tabelas do canal oficial. Tudo que entra é gravado antes de ser processado (webhook durável)
// e tudo que sai passa pelo outbox (retry, ordem por destinatário, janela de 24h, opt-in/opt-out).
import { db, get, now, run } from '../db.ts';
import type { Phone } from './types.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS wa_contacts (
  phone TEXT PRIMARY KEY,
  profile_name TEXT,
  -- prova do opt-in: quando e o quê (texto literal da resposta ou do checkbox)
  opt_in_at TEXT,
  opt_in_text TEXT,
  opt_out_at TEXT,
  opt_out_text TEXT,
  -- janela de 24h: última mensagem que a pessoa NOS mandou
  last_inbound_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_inbound (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_msg_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- message | status
  status_value TEXT NOT NULL DEFAULT '', -- pro kind=status (sent/delivered/read…); '' pras mensagens
  from_phone TEXT,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed
  error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE (provider_msg_id, kind, status_value)
);
CREATE INDEX IF NOT EXISTS wa_inbound_pending ON wa_inbound (state) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS wa_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_phone TEXT NOT NULL,
  kind TEXT NOT NULL,              -- template | text | interactive
  template_key TEXT,
  payload_json TEXT NOT NULL,      -- {vars} | {text} | {body, buttons}
  ref TEXT,                        -- quem pediu (ex.: "offer:12"), pra rastrear
  not_before TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued', -- queued | sending | sent | failed | blocked
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  provider_msg_id TEXT UNIQUE,
  delivery_status TEXT,            -- sent | delivered | read | failed | undelivered (callback)
  created_at TEXT NOT NULL,
  sent_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wa_outbox_queue ON wa_outbox (state, not_before);
CREATE INDEX IF NOT EXISTS wa_outbox_to ON wa_outbox (to_phone, id);

CREATE TABLE IF NOT EXISTS wa_content_cache (
  hash TEXT PRIMARY KEY,
  content_sid TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

// formato que o WhatsApp usa pra esse telefone (ex.: sem o 9º dígito); null = o próprio phone
if (!(db.prepare('PRAGMA table_info(wa_contacts)').all() as { name: string }[]).some((c) => c.name === 'wa_id')) {
  db.exec('ALTER TABLE wa_contacts ADD COLUMN wa_id TEXT');
}

export type ContactRow = {
  phone: Phone;
  wa_id?: string | null;
  profile_name: string | null;
  opt_in_at: string | null;
  opt_in_text: string | null;
  opt_out_at: string | null;
  opt_out_text: string | null;
  last_inbound_at: string | null;
};

export const WINDOW_MS = 24 * 3600_000;

export function getContact(phone: Phone) {
  return get<ContactRow>('SELECT * FROM wa_contacts WHERE phone = ?', phone);
}

function ensureContact(phone: Phone) {
  const t = now();
  run('INSERT OR IGNORE INTO wa_contacts (phone, created_at, updated_at) VALUES (?, ?, ?)', phone, t, t);
}

/** Guarda o formato exato que o WhatsApp usa pra esse telefone (aprendido de uma mensagem dele ou de uma falha). */
export function setWaId(phone: Phone, waId: string | null) {
  ensureContact(phone);
  run('UPDATE wa_contacts SET wa_id = ?, updated_at = ? WHERE phone = ?', waId && waId !== phone ? waId : null, now(), phone);
}

export function touchInbound(phone: Phone, at: string, profileName: string | null) {
  ensureContact(phone);
  run(
    'UPDATE wa_contacts SET last_inbound_at = MAX(COALESCE(last_inbound_at, ?), ?), profile_name = COALESCE(?, profile_name), updated_at = ? WHERE phone = ?',
    at, at, profileName, now(), phone,
  );
}

/** Grava o opt-in com a prova (texto literal). Também desfaz um opt-out anterior. */
export function recordOptIn(phone: Phone, text: string) {
  ensureContact(phone);
  const t = now();
  run('UPDATE wa_contacts SET opt_in_at = ?, opt_in_text = ?, opt_out_at = NULL, opt_out_text = NULL, updated_at = ? WHERE phone = ?', t, text.slice(0, 500), t, phone);
}

export function recordOptOut(phone: Phone, text: string) {
  ensureContact(phone);
  const t = now();
  run('UPDATE wa_contacts SET opt_out_at = ?, opt_out_text = ?, updated_at = ? WHERE phone = ?', t, text.slice(0, 500), t, phone);
  // nada mais sai pra essa pessoa
  run("UPDATE wa_outbox SET state = 'blocked', last_error = 'opt-out', updated_at = ? WHERE to_phone = ? AND state = 'queued'", t, phone);
}

export function windowOpen(phone: Phone, at = Date.now()) {
  const c = getContact(phone);
  return !!c?.last_inbound_at && at - new Date(c.last_inbound_at).getTime() < WINDOW_MS;
}
