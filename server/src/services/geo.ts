// Corrige cidade/bairro digitados ("Cidade b" -> "Cidade Baixa") pro nome oficial,
// pra o que fica salvo ser o lugar que o usuário confirmou no mapa, não o texto cru.
import { hasClaude, MODELS, runTurn, textOf } from '../agents/claude.ts';

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
