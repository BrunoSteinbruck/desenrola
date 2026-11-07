// V2 — banco próprio de prestadores: cadastro (pelo admin), opt-in, regiões, matching.
// O opt-in mora só em wa_contacts (channel/store.ts); aqui fica o perfil e o status do prestador.
import { all, areaKey, db, get, now, run, type ProviderRow } from '../db.ts';
import '../channel/store.ts'; // wa_contacts (opt-in) precisa existir antes do matching
import { formatBR, toE164BR } from '../services/phone.ts';

function addColumn(table: string, col: string, def: string) {
  const cols = all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

// lead = achado em busca (V1/Google), nunca recebe mensagem automática
// convidado = cadastrado no admin, boas_vindas enviado, esperando o "Sim"
// ativo = confirmou; recebe pedidos · pausado = pausado por nós · saiu = pediu pra sair · bloqueado
addColumn('providers', 'status', "TEXT NOT NULL DEFAULT 'lead'");
addColumn('providers', 'categories', "TEXT NOT NULL DEFAULT ''"); // "eletricista, encanador"
addColumn('providers', 'bio', 'TEXT');
addColumn('providers', 'paused_until', 'TEXT'); // "Agora não": sem ofertas até essa hora
addColumn('providers', 'created_at', 'TEXT');
addColumn('providers', 'notes', 'TEXT');
// oferta → negociação no número único
addColumn('request_providers', 'offered_at', 'TEXT');
addColumn('request_providers', 'viewed_at', 'TEXT');
addColumn('request_providers', 'queued_at', 'TEXT');

db.exec(`
CREATE TABLE IF NOT EXISTS provider_regions (
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  city_key TEXT NOT NULL,
  city TEXT NOT NULL,
  neighborhood_key TEXT NOT NULL DEFAULT '', -- '' = a cidade inteira
  neighborhood TEXT,
  PRIMARY KEY (provider_id, city_key, neighborhood_key)
);
CREATE INDEX IF NOT EXISTS provider_regions_city ON provider_regions (city_key, neighborhood_key);

CREATE TABLE IF NOT EXISTS handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  provider_id INTEGER,
  rp_id INTEGER,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'aberto', -- aberto | fechado
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS handoffs_open ON handoffs (status, phone);
`);

export type ProviderStatus = 'lead' | 'convidado' | 'ativo' | 'pausado' | 'saiu' | 'bloqueado';
export type ProviderV2 = ProviderRow & {
  status: ProviderStatus;
  categories: string;
  bio: string | null;
  paused_until: string | null;
  created_at: string | null;
  notes: string | null;
};

export const getProviderV2 = (id: number) => get<ProviderV2>('SELECT * FROM providers WHERE id = ?', id);

/** Prestador cadastrado (não lead) com esse telefone. Leads da V1 ficam de fora: não são conversa nossa. */
export function providerByPhone(phone: string) {
  return get<ProviderV2>("SELECT * FROM providers WHERE phone_e164 = ? AND status != 'lead' ORDER BY id DESC LIMIT 1", phone);
}

export function splitList(s: string) {
  return s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export class ProviderError extends Error {
  constructor(message: string, public httpStatus = 400) {
    super(message);
  }
}

export type ProviderInput = {
  name: string;
  phone: string;
  categories: string[];
  city: string;
  /** vazio = atende a cidade inteira */
  neighborhoods: string[];
  bio?: string | null;
  notes?: string | null;
};

/** Cadastro pelo admin. Reaproveita o registro se o telefone já existir (ex.: lead da V1). */
export function upsertProviderFromAdmin(input: ProviderInput): ProviderV2 {
  const phone = toE164BR(input.phone);
  if (!phone) throw new ProviderError('Telefone inválido. Use DDD + número, ex.: (51) 99999-8888.');
  const name = input.name.trim();
  if (!name) throw new ProviderError('Informe o nome.');
  const cats = input.categories.map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (!cats.length) throw new ProviderError('Informe ao menos uma categoria (ex.: eletricista).');
  if (!input.city.trim()) throw new ProviderError('Informe a cidade.');

  const existing = get<ProviderV2>('SELECT * FROM providers WHERE phone_e164 = ? ORDER BY id LIMIT 1', phone);
  let id: number;
  if (existing) {
    id = existing.id;
    const status = existing.status === 'lead' ? 'convidado' : existing.status;
    run(
      'UPDATE providers SET name = ?, categories = ?, bio = ?, notes = COALESCE(?, notes), status = ?, created_at = COALESCE(created_at, ?) WHERE id = ?',
      name, cats.join(', '), input.bio ?? existing.bio, input.notes ?? null, status, now(), id,
    );
  } else {
    const r = run(
      "INSERT INTO providers (name, phone_e164, source, status, categories, bio, notes, created_at) VALUES (?, ?, 'cadastro', 'convidado', ?, ?, ?, ?)",
      name, phone, cats.join(', '), input.bio ?? null, input.notes ?? null, now(),
    );
    id = Number(r.lastInsertRowid);
  }
  setRegions(id, input.city, input.neighborhoods);
  return getProviderV2(id)!;
}

export function setRegions(providerId: number, city: string, neighborhoods: string[]) {
  run('DELETE FROM provider_regions WHERE provider_id = ?', providerId);
  const hoods = neighborhoods.map((n) => n.trim()).filter(Boolean);
  const ins = (nk: string, n: string | null) =>
    run(
      'INSERT OR IGNORE INTO provider_regions (provider_id, city_key, city, neighborhood_key, neighborhood) VALUES (?, ?, ?, ?, ?)',
      providerId, areaKey(city), city.trim(), nk, n,
    );
  if (!hoods.length) ins('', null);
  for (const h of hoods) ins(areaKey(h), h);
}

export function regionsOf(providerId: number) {
  return all<{ city: string; neighborhood: string | null }>(
    'SELECT city, neighborhood FROM provider_regions WHERE provider_id = ? ORDER BY rowid',
    providerId,
  );
}

export function setProviderStatus(id: number, status: ProviderStatus) {
  run('UPDATE providers SET status = ? WHERE id = ?', status, id);
}

/** O canal confirmou opt-in/opt-out de um telefone: reflete no prestador. */
export function onProviderConsent(phone: string, kind: 'opt_in' | 'opt_out') {
  const p = providerByPhone(phone);
  if (!p || p.status === 'bloqueado') return null;
  if (kind === 'opt_in' && ['convidado', 'saiu', 'ativo'].includes(p.status)) setProviderStatus(p.id, 'ativo');
  if (kind === 'opt_out') setProviderStatus(p.id, 'saiu');
  return p;
}

// ---------- matching ----------

/** quantas ofertas um prestador pode receber por dia (não vira spam e não derruba a qualidade do número) */
export const DAILY_OFFER_CAP = 10;

const catMatch = (providerCats: string, category: string) => {
  const want = areaKey(category);
  return splitList(providerCats).some((c) => {
    const k = areaKey(c);
    return k === want || k.includes(want) || want.includes(k);
  });
};

export type Candidate = ProviderV2 & { sameHood: boolean; offersToday: number; offersWeek: number; responseRate: number | null };

/**
 * Prestadores que podem receber esse pedido: ativos, com opt-in válido, categoria e região que batem,
 * sem pausa e abaixo do limite diário. Ordem: nota no Desenrola, taxa de resposta, mesmo bairro,
 * quem recebeu menos ofertas na semana.
 */
export function eligibleProviders(category: string, city: string, neighborhood: string | null): Candidate[] {
  const cityKey = areaKey(city);
  const hoodKey = areaKey(neighborhood);
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const rows = all<ProviderV2 & { hood_hit: number }>(
    `SELECT p.*, MAX(CASE WHEN r.neighborhood_key = ? AND ? != '' THEN 1 ELSE 0 END) AS hood_hit
       FROM providers p
       JOIN provider_regions r ON r.provider_id = p.id AND r.city_key = ? AND (r.neighborhood_key = '' OR r.neighborhood_key = ?)
       JOIN wa_contacts c ON c.phone = p.phone_e164 AND c.opt_in_at IS NOT NULL AND c.opt_out_at IS NULL
      WHERE p.status = 'ativo' AND p.blocked = 0 AND (p.paused_until IS NULL OR p.paused_until < ?)
      GROUP BY p.id`,
    hoodKey, hoodKey, cityKey, hoodKey, now(),
  );
  return rows
    .filter((p) => catMatch(p.categories, category))
    .map((p) => {
      const stats = get<{ today: number; week: number; answered: number; offered: number }>(
        `SELECT SUM(offered_at >= ?) AS today, SUM(offered_at >= ?) AS week,
                SUM(viewed_at IS NOT NULL OR status = 'recusou') AS answered, COUNT(*) AS offered
           FROM request_providers WHERE provider_id = ? AND offered_at IS NOT NULL`,
        dayAgo, weekAgo, p.id,
      )!;
      return {
        ...p,
        sameHood: !!p.hood_hit,
        offersToday: stats.today ?? 0,
        offersWeek: stats.week ?? 0,
        responseRate: stats.offered ? (stats.answered ?? 0) / stats.offered : null,
      };
    })
    .filter((p) => p.offersToday < DAILY_OFFER_CAP)
    .sort((a, b) => score(b) - score(a));
}

function score(p: Candidate) {
  // nota com prior: quem é novo começa em 4,0 (não some do ranking nem passa na frente de quem é bom)
  const n = p.our_rating_count ?? 0;
  const rating = (4 * 3 + (p.our_rating_avg ?? 0) * n) / (3 + n);
  return rating * 2 + (p.responseRate ?? 0.7) * 2 + (p.sameHood ? 1 : 0) - Math.min(p.offersWeek, 20) * 0.05;
}

// ---------- views do admin ----------

export function adminProvidersView() {
  return all<ProviderV2 & { opt_in_at: string | null; opt_out_at: string | null; opt_in_text: string | null }>(
    `SELECT p.*, c.opt_in_at, c.opt_out_at, c.opt_in_text FROM providers p
       LEFT JOIN wa_contacts c ON c.phone = p.phone_e164
      WHERE p.status != 'lead' ORDER BY p.id DESC`,
  ).map((p) => ({
    id: p.id,
    name: p.name,
    phone: p.phone_e164,
    phone_display: p.phone_e164 ? formatBR(p.phone_e164) : null,
    status: p.status,
    categories: splitList(p.categories),
    regions: regionsOf(p.id),
    bio: p.bio,
    notes: p.notes,
    paused_until: p.paused_until,
    opt_in_at: p.opt_in_at,
    opt_in_text: p.opt_in_text,
    opt_out_at: p.opt_out_at,
    our_rating_avg: p.our_rating_count ? p.our_rating_avg : null,
    our_rating_count: p.our_rating_count,
    created_at: p.created_at,
  }));
}
