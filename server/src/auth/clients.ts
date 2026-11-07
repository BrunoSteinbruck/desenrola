// V2 F2 — clientes de verdade: cada um entra com o celular (código pelo WhatsApp) e só vê os próprios pedidos.
// Código: 6 dígitos, guardado só o hash, vale 10 min, 5 tentativas com reserva atômica (padrão do Convivar),
// limite de envios por telefone e por IP (persistente) contra abuso.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { all, db, get, getSetting, now, run } from '../db.ts';

function addColumn(table: string, col: string, def: string) {
  const cols = all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

db.exec(`
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT 'Porto Alegre',
  neighborhood TEXT NOT NULL DEFAULT '',
  onboarding_done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  client_id INTEGER,          -- NULL = sessão de admin
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_client ON sessions (client_id);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS otp_phone ON otp_codes (phone, id);
CREATE INDEX IF NOT EXISTS otp_ip ON otp_codes (ip, created_at);
`);
addColumn('requests', 'client_id', 'INTEGER');
// visitante: entrou sem celular (cookie). Vira cliente de verdade quando confirma o código. phone = "guest:<aleatório>"
addColumn('clients', 'is_guest', 'INTEGER NOT NULL DEFAULT 0');

export type ClientRow = {
  id: number;
  phone: string;
  name: string;
  city: string;
  neighborhood: string;
  onboarding_done: number;
  created_at: string;
  last_login_at: string | null;
  is_guest: number;
};

export const getClient = (id: number) => get<ClientRow>('SELECT * FROM clients WHERE id = ?', id);
export const clientByPhone = (phone: string) => get<ClientRow>('SELECT * FROM clients WHERE phone = ?', phone);

/** Dono do pedido (null em pedidos antigos sem dono). */
export function clientOfRequest(requestId: number) {
  return get<ClientRow>('SELECT c.* FROM clients c JOIN requests r ON r.client_id = c.id WHERE r.id = ?', requestId) ?? null;
}

export function clientView(c: ClientRow) {
  const guest = !!c.is_guest;
  return {
    id: c.id,
    is_guest: guest,
    phone: guest ? '' : c.phone,
    user_name: c.name,
    user_city: c.city,
    user_neighborhood: c.neighborhood,
    user_phone: guest ? '' : c.phone,
    onboarding_done: !!c.onboarding_done,
  };
}

/** Visitante novo (sem celular). Pode conversar com o diagnóstico; pra avisar profissionais precisa entrar. */
export function createGuest(): ClientRow {
  const r = run('INSERT INTO clients (phone, is_guest, created_at) VALUES (?, 1, ?)', `guest:${randomBytes(12).toString('hex')}`, now());
  return getClient(Number(r.lastInsertRowid))!;
}

export function updateClient(id: number, f: Partial<Pick<ClientRow, 'name' | 'city' | 'neighborhood' | 'onboarding_done'>>) {
  const cols = Object.keys(f) as (keyof typeof f)[];
  if (!cols.length) return;
  run(`UPDATE clients SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => f[c] as string | number), id);
}

// A V1/F3 guardava um usuário só em `settings`. Se ele tinha celular, vira o primeiro cliente e herda os pedidos.
{
  const phone = getSetting('user_phone');
  if (phone && !clientByPhone(phone)) {
    const r = run(
      'INSERT INTO clients (phone, name, city, neighborhood, onboarding_done, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      phone, getSetting('user_name'), getSetting('user_city') || 'Porto Alegre', getSetting('user_neighborhood'),
      getSetting('onboarding_done') === '1' ? 1 : 0, now(),
    );
    run('UPDATE requests SET client_id = ? WHERE client_id IS NULL', Number(r.lastInsertRowid));
  }
}

// ---------- código de verificação ----------

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
const PER_PHONE_15MIN = 3;
const PER_PHONE_DAY = 10;
const PER_IP_HOUR = 20;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** O hash leva o telefone junto: o mesmo código pra dois números não colide. */
const codeHash = (phone: string, code: string) => sha(`${phone}:${code}`);

export class AuthError extends Error {
  constructor(message: string, public httpStatus = 400, public code?: string) {
    super(message);
  }
}

/** Gera e guarda um código. Quem chama manda pelo WhatsApp. */
export function issueCode(phone: string, ip: string | null): string {
  const t = Date.now();
  const since = (ms: number) => new Date(t - ms).toISOString();
  const n15 = get<{ n: number }>('SELECT COUNT(*) AS n FROM otp_codes WHERE phone = ? AND created_at >= ?', phone, since(15 * 60_000))!.n;
  const nDay = get<{ n: number }>('SELECT COUNT(*) AS n FROM otp_codes WHERE phone = ? AND created_at >= ?', phone, since(24 * 3600_000))!.n;
  if (n15 >= PER_PHONE_15MIN || nDay >= PER_PHONE_DAY) throw new AuthError('Muitos códigos pedidos pra esse número. Espera uns minutos e tenta de novo.', 429, 'rate_limited');
  if (ip) {
    const nIp = get<{ n: number }>('SELECT COUNT(*) AS n FROM otp_codes WHERE ip = ? AND created_at >= ?', ip, since(3600_000))!.n;
    if (nIp >= PER_IP_HOUR) throw new AuthError('Muitas tentativas daqui. Espera um pouco e tenta de novo.', 429, 'rate_limited');
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  run(
    'INSERT INTO otp_codes (phone, code_hash, expires_at, created_at, ip) VALUES (?, ?, ?, ?, ?)',
    phone, codeHash(phone, code), new Date(t + CODE_TTL_MS).toISOString(), now(), ip,
  );
  return code;
}

/** Confere o código mais recente do telefone. A tentativa é "gasta" antes de comparar (rajada paralela não passa de 5). */
export function verifyCode(phone: string, code: string): boolean {
  const row = get<{ id: number; code_hash: string; expires_at: string }>(
    'SELECT id, code_hash, expires_at FROM otp_codes WHERE phone = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1',
    phone,
  );
  if (!row || row.expires_at < now()) throw new AuthError('Código expirado. Pede outro.', 400, 'expired');
  const claim = run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < ? AND used_at IS NULL', row.id, MAX_ATTEMPTS);
  if (Number(claim.changes) === 0) throw new AuthError('Tentativas demais. Pede um código novo.', 429, 'too_many_attempts');
  const a = Buffer.from(codeHash(phone, code.replace(/\D/g, '')));
  const b = Buffer.from(row.code_hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const used = run('UPDATE otp_codes SET used_at = ? WHERE id = ? AND used_at IS NULL', now(), row.id);
  return Number(used.changes) === 1;
}

/** Era de usuário único (sem login): o primeiro cliente de verdade herda os pedidos e o perfil que já existiam. */
function inheritSingleUser(c: ClientRow) {
  run('UPDATE requests SET client_id = ? WHERE client_id IS NULL', c.id);
  updateClient(c.id, {
    name: c.name || getSetting('user_name'),
    city: c.neighborhood ? c.city : getSetting('user_city') || c.city || 'Porto Alegre',
    neighborhood: c.neighborhood || getSetting('user_neighborhood'),
    onboarding_done: c.onboarding_done || getSetting('onboarding_done') === '1' ? 1 : 0,
  });
}

/**
 * Login confirmado. Se quem confirmou era um visitante, os pedidos dele vão junto:
 * - número já tem conta → pedidos e perfil do visitante passam pra ela e o visitante some;
 * - número novo → o próprio visitante vira o cliente (mesmo id, mesmos pedidos).
 */
export function loginClient(phone: string, currentClientId: number | null = null): ClientRow {
  const existing = clientByPhone(phone);
  const cur = currentClientId ? getClient(currentClientId) : undefined;
  const guest = cur?.is_guest ? cur : undefined;
  const firstReal = get<{ n: number }>('SELECT COUNT(*) AS n FROM clients WHERE is_guest = 0')!.n === 0;
  let c: ClientRow;
  if (existing) {
    if (guest) {
      run('UPDATE requests SET client_id = ? WHERE client_id = ?', existing.id, guest.id);
      updateClient(existing.id, {
        name: existing.name || guest.name,
        city: existing.neighborhood ? existing.city : guest.city || existing.city,
        neighborhood: existing.neighborhood || guest.neighborhood,
        onboarding_done: existing.onboarding_done || guest.onboarding_done,
      });
      run('DELETE FROM sessions WHERE client_id = ?', guest.id);
      run('DELETE FROM clients WHERE id = ?', guest.id);
    }
    c = existing;
  } else if (guest) {
    run('UPDATE clients SET phone = ?, is_guest = 0 WHERE id = ?', phone, guest.id);
    c = getClient(guest.id)!;
    if (firstReal) inheritSingleUser(c);
  } else {
    run('INSERT INTO clients (phone, created_at) VALUES (?, ?)', phone, now());
    c = clientByPhone(phone)!;
    if (firstReal) inheritSingleUser(c);
  }
  run('UPDATE clients SET last_login_at = ? WHERE id = ?', now(), c.id);
  return getClient(c.id)!;
}

/** Visitantes que não fizeram nada em 7 dias somem (com as sessões). */
export function sweepGuests() {
  const old = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const ids = all<{ id: number }>(
    'SELECT c.id FROM clients c WHERE c.is_guest = 1 AND c.created_at < ? AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.client_id = c.id)',
    old,
  ).map((r) => r.id);
  for (const id of ids) {
    run('DELETE FROM sessions WHERE client_id = ?', id);
    run('DELETE FROM clients WHERE id = ?', id);
  }
  return ids.length;
}

// ---------- sessões ----------

export const SESSION_DAYS = 30;

export function createSession(clientId: number | null, isAdmin = false): string {
  const token = randomBytes(32).toString('base64url');
  run(
    'INSERT INTO sessions (token_hash, client_id, is_admin, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    sha(token), clientId, isAdmin ? 1 : 0, now(), new Date(Date.now() + (isAdmin ? 7 : SESSION_DAYS) * 24 * 3600_000).toISOString(),
  );
  return token;
}

export function sessionFor(token: string | undefined) {
  if (!token) return null;
  return get<{ client_id: number | null; is_admin: number }>(
    'SELECT client_id, is_admin FROM sessions WHERE token_hash = ? AND expires_at > ?',
    sha(token), now(),
  ) ?? null;
}

export function deleteSession(token: string | undefined) {
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha(token));
}
