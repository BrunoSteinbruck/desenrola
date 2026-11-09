// Corrige cidade/bairro digitados ("Cidade b" -> "Cidade Baixa") pro nome oficial,
// pra o que fica salvo ser o lugar que o usuário confirmou no mapa, não o texto cru.
import { hasClaude, MODELS, runTurn, textOf } from '../agents/claude.ts';
import { db, get, now, run } from '../db.ts';
import { hasPlaces } from './places.ts';

// ---------- bairros da cidade (sugestões do campo Bairro) ----------
// Uma chamada ao modelo por cidade, guardada no banco. São só sugestões: o que vale é o que a pessoa confirma no mapa.
db.exec(`CREATE TABLE IF NOT EXISTS geo_neighborhoods (city_key TEXT PRIMARY KEY, names_json TEXT NOT NULL, created_at TEXT NOT NULL)`);

const LIST_SYSTEM =
  'Tu recebe o nome de uma cidade do Brasil e devolve os bairros dela, com o nome oficial e bem escritos. ' +
  'Inclui só bairros que tu tem certeza que existem nessa cidade; é melhor faltar um do que inventar. ' +
  'Se a cidade não existir, devolve a lista vazia.';
const LIST_SCHEMA = {
  type: 'object',
  properties: { bairros: { type: 'array', items: { type: 'string' } } },
  required: ['bairros'],
  additionalProperties: false,
};
/** teto de cidades novas por dia: a rota é aberta a visitantes e cada cidade nova custa uma chamada */
const NEW_CITIES_PER_DAY = 100;
let budget = { day: '', used: 0 };
const inFlight = new Map<string, Promise<string[]>>();
const cityKey = (c: string) => c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * O modelo às vezes inventa bairro ou repete com outra grafia: só fica o que o Google conhece como bairro dessa cidade,
 * com o nome escrito como no Google. Sem chave ou com o Google fora do ar, fica a lista do modelo.
 */
async function confirmedByGoogle(names: string[], city: string): Promise<string[]> {
  if (!hasPlaces()) return names;
  const wanted = cityKey(city);
  const out = new Set<string>();
  try {
    for (let i = 0; i < names.length; i += 10) {
      const found = await Promise.all(
        names.slice(i, i + 10).map(async (name) => {
          const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY! },
            body: JSON.stringify({ input: `${name}, ${city}`, languageCode: 'pt-BR', regionCode: 'br', includedRegionCodes: ['br'], includedPrimaryTypes: ['sublocality', 'neighborhood'] }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`Places autocomplete ${res.status}`);
          const data = (await res.json()) as { suggestions?: { placePrediction?: { structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } } } }[] };
          const hit = (data.suggestions ?? [])
            .map((x) => x.placePrediction?.structuredFormat)
            .find((f) => cityKey(f?.secondaryText?.text ?? '').startsWith(wanted) && cityKey(f?.mainText?.text ?? '') === cityKey(name));
          return hit?.mainText?.text ?? null;
        }),
      );
      for (const f of found) if (f) out.add(f);
    }
    return [...out].sort((x, y) => x.localeCompare(y, 'pt-BR'));
  } catch (err) {
    console.warn('[geo] não consegui conferir os bairros no Google', err);
    return names;
  }
}

export function neighborhoodsOfCity(city: string): Promise<string[]> {
  const key = cityKey(city);
  if (key.length < 2) return Promise.resolve([]);
  const saved = get<{ names_json: string }>('SELECT names_json FROM geo_neighborhoods WHERE city_key = ?', key);
  if (saved) return Promise.resolve(JSON.parse(saved.names_json) as string[]);
  if (!hasClaude()) return Promise.resolve([]);
  const running = inFlight.get(key);
  if (running) return running;
  const day = new Date().toISOString().slice(0, 10);
  if (budget.day !== day) budget = { day, used: 0 };
  if (budget.used >= NEW_CITIES_PER_DAY) return Promise.resolve([]);
  budget.used++;
  const job = (async () => {
    try {
      const r = await runTurn({
        model: MODELS.geo,
        system: LIST_SYSTEM,
        messages: [{ role: 'user', content: `Cidade: ${city.trim()}` }],
        effort: 'low',
        maxTokens: 4000,
        format: { type: 'json_schema', schema: LIST_SCHEMA },
      });
      const parsed = JSON.parse(textOf(r.message)) as { bairros: string[] };
      const names = await confirmedByGoogle([...new Set(parsed.bairros.map((b) => b.trim()).filter(Boolean))].slice(0, 120), city.trim());
      run('INSERT OR REPLACE INTO geo_neighborhoods (city_key, names_json, created_at) VALUES (?, ?, ?)', key, JSON.stringify(names), now());
      return names;
    } catch (err) {
      console.warn('[geo] não consegui listar os bairros', err);
      return [];
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

export interface Place { city: string; neighborhood: string; found: boolean }

const SYSTEM =
  'Tu recebe uma cidade e um bairro do Brasil digitados por uma pessoa, possivelmente abreviados, incompletos ou com erro de digitação. ' +
  'Devolve o nome oficial e bem escrito da cidade e do bairro (ex.: "porto alegre" + "Cidade b" -> "Porto Alegre" + "Cidade Baixa"). ' +
  'Se não tiver certeza de qual bairro é, devolve o bairro como foi digitado, só com a grafia arrumada, e encontrado = false.';

const SCHEMA = {
  type: 'object',
  properties: {
    cidade: { type: 'string' },
    bairro: { type: 'string' },
    encontrado: { type: 'boolean' },
  },
  required: ['cidade', 'bairro', 'encontrado'],
  additionalProperties: false,
};

const cache = new Map<string, Place>();

export async function normalizePlace(city: string, neighborhood: string): Promise<Place> {
  const c = city.trim();
  const n = neighborhood.trim();
  const key = `${c.toLowerCase()}|${n.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const fallback: Place = { city: c, neighborhood: n, found: false };
  if (!hasClaude() || !c || !n) return fallback;
  try {
    const r = await runTurn({
      model: MODELS.geo,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Cidade: ${c}\nBairro: ${n}` }],
      effort: 'low',
      maxTokens: 2000,
      format: { type: 'json_schema', schema: SCHEMA },
    });
    const j = JSON.parse(textOf(r.message)) as { cidade: string; bairro: string; encontrado: boolean };
    const place: Place = { city: j.cidade?.trim() || c, neighborhood: j.bairro?.trim() || n, found: !!j.encontrado };
    cache.set(key, place);
    return place;
  } catch (err) {
    console.warn('[geo] não consegui normalizar', err);
    return fallback;
  }
}
