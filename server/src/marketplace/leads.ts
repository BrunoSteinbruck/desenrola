// F4 — Recrutamento: os contatos achados nas buscas (leads) viram profissionais cadastrados.
// O Bruno convida à mão (ligação ou chip de recrutamento, nunca o número da plataforma) e,
// quando o contato topa, "Cadastrar" o transforma em profissional e manda o boas_vindas (opt-in).
import { all, areaKey, db, get, run } from '../db.ts';
import { formatBR } from '../services/phone.ts';
import { splitList } from './providers.ts';
import { siteUrl } from './offers.ts';

function addColumn(table: string, col: string, def: string) {
  const cols = all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
// novo | convidado | recusou | sem_whatsapp (cadastrado = status do prestador deixa de ser 'lead')
addColumn('providers', 'lead_status', "TEXT NOT NULL DEFAULT 'novo'");
addColumn('providers', 'lead_note', 'TEXT');

export const LEAD_STATUSES = ['novo', 'convidado', 'recusou', 'sem_whatsapp'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

type LeadRow = {
  id: number;
  name: string;
  phone_e164: string | null;
  rating_google: number | null;
  reviews_google: number | null;
  address: string | null;
  website: string | null;
  lead_status: LeadStatus;
  lead_note: string | null;
  lead_demand: number;
  lead_last_demand_at: string | null;
  categories: string;
  cities: string;
  hoods: string | null;
  times_found: number;
  last_seen_at: string;
};

/** Pedidos sem profissional cadastrado nos últimos 30 dias, por profissão e cidade. */
function unmetDemand() {
  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  return all<{ category: string; city: string; neighborhoods: string | null; n: number; last_at: string }>(
    `SELECT category, city, GROUP_CONCAT(DISTINCT neighborhood) AS neighborhoods, COUNT(*) AS n, MAX(updated_at) AS last_at
       FROM requests
      WHERE status = 'sem_prestadores' AND category IS NOT NULL AND updated_at >= ?
      GROUP BY lower(category), lower(COALESCE(city, ''))
      ORDER BY n DESC, last_at DESC LIMIT 30`,
    since,
  );
}

/** Texto pronto pro convite (copiar e mandar à mão). */
export function inviteText(lead: { name: string; category: string; city: string; demand: number }) {
  const first = lead.name.split(/\s+/)[0];
  const pedidos =
    lead.demand > 1
      ? `${lead.demand} clientes tentaram te chamar pelo Desenrola`
      : lead.demand === 1
        ? 'um cliente tentou te chamar pelo Desenrola'
        : `clientes de ${lead.city} estão pedindo ${lead.category} pelo Desenrola`;
  return (
    `Oi, ${first}! Aqui é o Bruno, do Desenrola. A gente avisa profissionais quando tem cliente da região precisando de ${lead.category}, ` +
    `e ${pedidos}. Quer receber esses pedidos no teu WhatsApp? Por enquanto é de graça. ` +
    `Se topar, o cadastro leva 2 minutos: ${siteUrl('/profissional')}`
  );
}

export function leadsView(filter: { category?: string; city?: string; status?: string; q?: string } = {}) {
  const rows = all<LeadRow>(
    `SELECT p.id, p.name, p.phone_e164, p.rating_google, p.reviews_google, p.address, p.website,
            p.lead_status, p.lead_note, p.lead_demand, p.lead_last_demand_at,
            GROUP_CONCAT(DISTINCT a.category) AS categories, GROUP_CONCAT(DISTINCT a.city) AS cities,
            GROUP_CONCAT(DISTINCT a.neighborhood) AS hoods,
            SUM(a.times_found) AS times_found, MAX(a.last_seen_at) AS last_seen_at
       FROM providers p JOIN provider_areas a ON a.provider_id = p.id
      WHERE p.status = 'lead' AND p.blocked = 0 AND COALESCE(p.source, '') != 'teste'
      GROUP BY p.id`,
  );
  const cat = areaKey(filter.category);
  const city = areaKey(filter.city);
  const q = areaKey(filter.q);
  return rows
    .filter((r) => !cat || splitList(r.categories).some((c) => areaKey(c).includes(cat)))
    .filter((r) => !city || splitList(r.cities).some((c) => areaKey(c) === city))
    .filter((r) => !filter.status || r.lead_status === filter.status)
    .filter((r) => !q || areaKey(`${r.name} ${r.categories} ${r.hoods ?? ''}`).includes(q))
    .sort(
      (a, b) =>
        b.lead_demand - a.lead_demand ||
        (b.rating_google ?? 0) * Math.log10((b.reviews_google ?? 0) + 1) - (a.rating_google ?? 0) * Math.log10((a.reviews_google ?? 0) + 1),
    )
    .map((r) => {
      const category = splitList(r.categories)[0] ?? 'serviços';
      const cityName = splitList(r.cities)[0] ?? 'Porto Alegre';
      return {
        id: r.id,
        name: r.name,
        phone: r.phone_e164,
        phone_display: r.phone_e164 ? formatBR(r.phone_e164) : null,
        mobile: !!r.phone_e164 && r.phone_e164.length === 13,
        rating: r.rating_google,
        reviews: r.reviews_google,
        address: r.address,
        website: r.website,
        categories: splitList(r.categories),
        cities: splitList(r.cities),
        neighborhoods: r.hoods ? splitList(r.hoods) : [],
        lead_status: r.lead_status,
        lead_note: r.lead_note,
        demand: r.lead_demand,
        last_demand_at: r.lead_last_demand_at,
        times_found: r.times_found,
        invite_text: inviteText({ name: r.name, category, city: cityName, demand: r.lead_demand }),
      };
    });
}

export function recruitingView(filter: Parameters<typeof leadsView>[0] = {}) {
  const leads = leadsView(filter);
  const registered = all<{ categories: string }>("SELECT categories FROM providers WHERE status IN ('ativo', 'convidado', 'pausado')");
  return {
    demand: unmetDemand().map((d) => ({
      ...d,
      neighborhoods: d.neighborhoods ? splitList(d.neighborhoods) : [],
      registered: registered.filter((p) => splitList(p.categories).some((c) => areaKey(c) === areaKey(d.category))).length,
      leads: leadsView({ category: d.category, city: d.city }).length,
    })),
    leads,
    counts: {
      leads: leads.length,
      novo: leads.filter((l) => l.lead_status === 'novo').length,
      convidado: leads.filter((l) => l.lead_status === 'convidado').length,
      with_demand: leads.filter((l) => l.demand > 0).length,
    },
  };
}

export function setLeadStatus(id: number, status: LeadStatus, note?: string | null) {
  const p = get<{ status: string }>('SELECT status FROM providers WHERE id = ?', id);
  if (!p || p.status !== 'lead') return false;
  run('UPDATE providers SET lead_status = ?, lead_note = COALESCE(?, lead_note) WHERE id = ?', status, note ?? null, id);
  return true;
}
