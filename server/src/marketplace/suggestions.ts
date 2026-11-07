// Contatos sugeridos: quando não há profissional cadastrado, mostramos contatos achados na internet
// pro CLIENTE chamar (link wa.me com a mensagem pronta). O nosso número nunca escreve pra eles.
//
// Toda busca fica registrada (lead_searches) e os contatos achados ficam no banco (providers + provider_areas).
// Com o tempo, a mesma profissão na mesma cidade sai do banco, sem pesquisar de novo.
import { all, areaKey, db, get, getRequest, now, postMessage, run, setRequestStatus } from '../db.ts';
import { formatBR, toE164BR } from '../services/phone.ts';
import { hasPlaces, searchPlaces, type Candidate } from '../services/places.ts';
import { ownProviders, searchWeb, tagArea, upsertProvider } from '../agents/buscador.ts';
import { friendlyError } from '../agents/claude.ts';
import { clientOfRequest } from '../auth/clients.ts';

function addColumn(table: string, col: string, def: string) {
  const cols = all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

db.exec(`
CREATE TABLE IF NOT EXISTS lead_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_key TEXT NOT NULL,
  category TEXT NOT NULL,
  city_key TEXT NOT NULL,
  city TEXT NOT NULL,
  neighborhood TEXT,
  source TEXT NOT NULL,          -- places | web
  found INTEGER NOT NULL,
  request_id INTEGER,
  searched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lead_searches_key ON lead_searches (category_key, city_key, searched_at);
`);
// demanda: quantas vezes um cliente quis chamar esse contato (os primeiros a convidar pro cadastro)
addColumn('providers', 'lead_demand', 'INTEGER NOT NULL DEFAULT 0');
addColumn('providers', 'lead_last_demand_at', 'TEXT');

/** quantos contatos mostrar */
export const SUGGEST_MAX = 5;
/** com pelo menos isso no banco, nem pesquisa */
export const ENOUGH_FROM_DB = 3;
/** uma busca vale por esse tempo pra mesma profissão + cidade (vazia vale menos: pode ter sido azar) */
export const SEARCH_TTL_MS = 60 * 24 * 3600_000;
export const EMPTY_SEARCH_TTL_MS = 7 * 24 * 3600_000;

type Searcher = (category: string, neighborhood: string, city: string, want: number) => Promise<{ source: 'places' | 'web'; found: Candidate[] }>;
let searcher: Searcher = async (category, neighborhood, city, want) =>
  hasPlaces()
    ? { source: 'places', found: await searchPlaces(`${category} em ${[neighborhood, city].filter(Boolean).join(', ')}`) }
    : { source: 'web', found: await searchWeb(category, neighborhood, city, want) };
export function setSearcherForTests(fn: Searcher) {
  searcher = fn;
}

/** Já pesquisamos essa profissão nessa cidade há pouco? */
export function recentSearch(category: string, city: string) {
  const row = get<{ found: number; searched_at: string }>(
    'SELECT found, searched_at FROM lead_searches WHERE category_key = ? AND city_key = ? ORDER BY id DESC LIMIT 1',
    areaKey(category), areaKey(city),
  );
  if (!row) return null;
  const age = Date.now() - new Date(row.searched_at).getTime();
  return age < (row.found > 0 ? SEARCH_TTL_MS : EMPTY_SEARCH_TTL_MS) ? row : null;
}

export type Suggestion = {
  provider_id: number;
  name: string;
  phone_display: string;
  rating: number | null;
  reviews: number | null;
  address: string | null;
  wa_url: string;
};

/** Mensagem que abre no WhatsApp do cliente, com as palavras dele. */
function prefilled(requestId: number) {
  const req = getRequest(requestId)!;
  const first = get<{ content: string }>("SELECT content FROM messages WHERE request_id = ? AND role = 'user' ORDER BY id LIMIT 1", requestId)?.content ?? '';
  const where = req.neighborhood ? ` Moro no bairro ${req.neighborhood}${req.city ? `, ${req.city}` : ''}.` : '';
  const problem = first.trim().replace(/\s+/g, ' ').slice(0, 300);
  return `Oi! Vi teu contato pelo Desenrola.${where}${problem ? ` ${problem.charAt(0).toUpperCase()}${problem.slice(1)}${/[.!?]$/.test(problem) ? '' : '.'}` : ''} Tu faz esse tipo de serviço? Mais ou menos quanto fica?`;
}

/**
 * Acha contatos pro pedido: primeiro o nosso banco; só pesquisa se o banco tiver pouco
 * E não houver busca recente pra essa profissão nessa cidade. Mostra num cartão.
 */
export async function suggestFor(requestId: number): Promise<Suggestion[]> {
  const req = getRequest(requestId);
  if (!req?.category) return [];
  const city = req.city || clientOfRequest(requestId)?.city || 'Porto Alegre';
  const hood = req.neighborhood ?? '';
  let pool = ownProviders(req.category, city, hood || null);

  if (pool.length < ENOUGH_FROM_DB && !recentSearch(req.category, city)) {
    setRequestStatus(requestId, 'buscando');
    try {
      const { source, found } = await searcher(req.category, hood, city, SUGGEST_MAX * 2);
      let saved = 0;
      for (const c of found) {
        const e164 = c.phone ? toE164BR(c.phone) : null;
        if (!e164) continue;
        const p = upsertProvider(c, e164);
        tagArea(p.id, req.category, city, hood || null);
        saved++;
      }
      run(
        'INSERT INTO lead_searches (category_key, category, city_key, city, neighborhood, source, found, request_id, searched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        areaKey(req.category), req.category, areaKey(city), city, hood || null, source, saved, requestId, now(),
      );
      console.log(`[sugestões] busca ${source}: ${req.category} em ${city} → ${saved} contatos guardados`);
      pool = ownProviders(req.category, city, hood || null);
    } catch (err) {
      console.error('[sugestões] busca falhou', err);
      if (!pool.length) {
        setRequestStatus(requestId, 'sem_prestadores');
        postMessage(requestId, 'system_event', `Não consegui procurar contatos agora: ${friendlyError(err)}`, { kind: 'error' });
        return [];
      }
    }
  } else {
    console.log(`[sugestões] ${req.category} em ${city}: ${pool.length} do banco, sem pesquisar`);
  }

  const text = encodeURIComponent(prefilled(requestId));
  const items: Suggestion[] = pool
    .filter((p) => p.phone_e164)
    .slice(0, SUGGEST_MAX)
    .map((p) => ({
      provider_id: p.id,
      name: p.name,
      phone_display: formatBR(p.phone_e164!),
      rating: p.rating_google,
      reviews: p.reviews_google,
      address: p.address,
      wa_url: `https://wa.me/${p.phone_e164}?text=${text}`,
    }));

  setRequestStatus(requestId, 'sem_prestadores');
  if (!items.length) {
    postMessage(requestId, 'assistant', `Também não achei contatos de ${req.category} em ${city} na internet. Anotei o pedido e te aviso quando tiver alguém cadastrado.`);
    return [];
  }
  postMessage(
    requestId,
    'assistant',
    `Enquanto isso, achei ${items.length === 1 ? 'este contato' : `estes ${items.length} contatos`} de ${req.category} na tua região. Eles ainda não são do Desenrola: tu mesmo chama no WhatsApp, com a mensagem já escrita.`,
    { kind: 'suggestions', items },
  );
  return items;
}

/** O cliente tocou em "Chamar no WhatsApp": conta como demanda (esse contato é o primeiro a convidar). */
export function recordSuggestionClick(requestId: number, providerId: number) {
  const ok = get('SELECT 1 FROM provider_areas a JOIN requests r ON r.id = ? WHERE a.provider_id = ?', requestId, providerId);
  if (!ok) return false;
  run('UPDATE providers SET lead_demand = lead_demand + 1, lead_last_demand_at = ? WHERE id = ?', now(), providerId);
  return true;
}
