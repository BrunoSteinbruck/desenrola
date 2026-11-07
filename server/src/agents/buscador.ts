// Buscador (V1; na V2 serve só pra achar LEADS de recrutamento: ninguém daqui recebe mensagem automática).
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  all, areaKey, get, getRequest, now, postMessage, run, setRequestStatus, type ProviderRow,
} from '../db.ts';
import { hasPlaces, searchPlaces, type Candidate } from '../services/places.ts';
import { toE164BR } from '../services/phone.ts';
import { friendlyError, runTurn, textOf , MODELS } from './claude.ts';
import { addDiagnosticoNote } from './diagnostico.ts';

const MAX_SHOW = 5;
/** Quantos vêm do nosso banco, no máximo. */
const OWN_MAX = 3;
/** Quantos novos da internet, no mínimo (gente que ainda não recomendamos). */
const NEW_MIN = 2;

export async function runSearch(requestId: number): Promise<void> {
  const req = getRequest(requestId);
  if (!req || !req.category) return;
  setRequestStatus(requestId, 'buscando');
  const city = req.city ?? 'Porto Alegre';
  const where = [req.neighborhood, city].filter(Boolean).join(', ');

  // 1) nosso banco: quem já apareceu pra essa profissão nessa cidade, melhores primeiro
  const own = ownProviders(req.category, city, req.neighborhood);
  const known = new Set(own.map((p) => p.id));
  const wantNew = Math.max(MAX_SHOW - Math.min(own.length, OWN_MAX), NEW_MIN);

  // 2) internet: sempre traz gente nova pra não ficar enviesado no nosso banco
  let candidates: Candidate[] = [];
  try {
    candidates = hasPlaces()
      ? await searchPlaces(`${req.category} em ${where}`)
      : await searchWeb(req.category, req.neighborhood ?? '', city, wantNew * 2 + 2);
  } catch (err) {
    console.error('[F2] busca falhou', err);
    if (!own.length) {
      setRequestStatus(requestId, 'diagnostico');
      const msg = err instanceof Error && err.message.startsWith('Places') ? 'A busca no Google falhou. Tenta de novo em instantes.' : friendlyError(err);
      postMessage(requestId, 'system_event', msg, { kind: 'error' });
      return;
    }
    // sem internet, segue só com o nosso banco
  }

  // normaliza, deduplica por telefone, grava no banco (com profissão/cidade) e separa os novos
  const seen = new Set<string>();
  const fresh: ProviderRow[] = [];
  for (const c of candidates) {
    const e164 = c.phone ? toE164BR(c.phone) : null;
    if (!e164 || seen.has(e164)) continue;
    seen.add(e164);
    const p = upsertProvider(c, e164);
    tagArea(p.id, req.category, city, req.neighborhood);
    if (!known.has(p.id) && !p.blocked) fresh.push(p);
  }
  const freshRanked = fresh.map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s).map((x) => x.p);

  // 3) valida WhatsApp (se conectado; sem conexão, valida no disparo) e monta: até 3 nossos + novos
  const chosen: ProviderRow[] = [];
  const noWa = 0;
  const take = async (list: ProviderRow[], limit: number) => {
    for (const p of list) {
      if (chosen.length >= limit) return;
      if (chosen.some((c) => c.id === p.id)) continue;
      chosen.push(p);
    }
  };
  await take(own, OWN_MAX);
  await take(freshRanked, MAX_SHOW);
  await take(own, MAX_SHOW); // faltou gente nova: completa com o resto do nosso banco
  console.log(`[F2] ${req.category} em ${where}: ${Math.min(own.length, OWN_MAX)} do banco, ${fresh.length} novos da internet, mostrando ${chosen.length}`);

  // helper de dev: o 2º celular do próprio usuário como prestador, sempre no topo
  const devPhone = process.env.DEV_TEST_PROVIDER_PHONE ? toE164BR(process.env.DEV_TEST_PROVIDER_PHONE) : null;
  if (devPhone) {
    const dev = upsertProvider(
      { name: 'Prestador de teste', phone: devPhone, rating: 5, reviews: 1, address: null, website: null, placeId: null, source: 'teste' },
      devPhone,
    );
    const idx = chosen.findIndex((p) => p.id === dev.id);
    if (idx >= 0) chosen.splice(idx, 1);
    chosen.unshift(dev);
  }

  run("DELETE FROM request_providers WHERE request_id = ? AND status IN ('sugerido','excluido')", requestId);
  chosen.forEach((p, i) => {
    run(
      `INSERT INTO request_providers (request_id, provider_id, position, selected, status) VALUES (?, ?, ?, 1, 'sugerido')
       ON CONFLICT(request_id, provider_id) DO NOTHING`,
      requestId, p.id, i,
    );
  });

  if (!chosen.length) {
    setRequestStatus(requestId, 'sem_prestadores');
    const why = noWa ? ' (os que achei não têm WhatsApp)' : '';
    postMessage(requestId, 'assistant', `Não achei ${req.category} com WhatsApp em ${where}${why}. Quer tentar outro bairro ou cidade aqui perto?`);
    addDiagnosticoNote(
      requestId,
      `Nota do sistema: a busca por ${req.category} em ${where} não achou prestadores com WhatsApp. Se o usuário indicar outro bairro/cidade ou outra profissão, chame definir_diagnostico de novo com os dados novos.`,
    );
    return;
  }
  setRequestStatus(requestId, 'escolhendo');
  const n = chosen.length;
  postMessage(
    requestId,
    'assistant',
    `Encontrei ${n === 1 ? 'esse' : `esses ${n}`}. Desmarca quem tu não quer e clica em "Chamar selecionados".`,
    { kind: 'providers' },
  );
}

/**
 * Nosso banco: prestadores já encontrados pra essa profissão nessa cidade.
 * Fora: bloqueados, o de teste e quem levou nota baixa dos nossos usuários.
 * Ordem: nota dos nossos usuários pesa mais, depois Google; bônus pra quem é do mesmo bairro.
 */
function ownProviders(category: string, city: string, neighborhood: string | null): ProviderRow[] {
  const rows = all<ProviderRow & { area_hood: string | null }>(
    `SELECT p.*, a.neighborhood AS area_hood FROM provider_areas a JOIN providers p ON p.id = a.provider_id
      WHERE a.category_key = ? AND a.city_key = ? AND p.blocked = 0 AND p.source != 'teste'
        AND (p.our_rating_count = 0 OR p.our_rating_avg >= 3.5)`,
    areaKey(category), areaKey(city),
  );
  const hood = areaKey(neighborhood);
  return rows
    .map((p) => ({ p, s: score(p) + (hood && areaKey(p.area_hood) === hood ? 1 : 0) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.p);
}

/** Guarda em que profissão/cidade esse prestador apareceu (base do nosso banco). */
function tagArea(providerId: number, category: string, city: string, neighborhood: string | null) {
  const ts = now();
  run(
    `INSERT INTO provider_areas (provider_id, category_key, category, city_key, city, neighborhood, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id, category_key, city_key) DO UPDATE SET
       times_found = times_found + 1, last_seen_at = excluded.last_seen_at,
       neighborhood = COALESCE(excluded.neighborhood, neighborhood)`,
    providerId, areaKey(category), category, areaKey(city), city, neighborhood, ts, ts,
  );
}

function score(p: ProviderRow): number {
  const base = (p.rating_google ?? 3.8) * Math.log10((p.reviews_google ?? 0) + 1);
  const ours = p.our_rating_avg != null && p.our_rating_count > 0 ? (p.our_rating_avg - 3) * Math.min(p.our_rating_count, 5) : 0;
  return base + ours - (p.blocked ? 100 : 0);
}

function upsertProvider(c: Candidate, e164: string): ProviderRow {
  const existing =
    (c.placeId ? get<ProviderRow>('SELECT * FROM providers WHERE place_id = ?', c.placeId) : undefined) ??
    get<ProviderRow>('SELECT * FROM providers WHERE phone_e164 = ? ORDER BY id LIMIT 1', e164);
  if (existing) {
    run(
      `UPDATE providers SET name = ?, phone_e164 = ?, place_id = COALESCE(?, place_id), rating_google = COALESCE(?, rating_google),
         reviews_google = COALESCE(?, reviews_google), address = COALESCE(?, address), website = COALESCE(?, website),
         wa_jid = CASE WHEN phone_e164 = ? THEN wa_jid ELSE NULL END
       WHERE id = ?`,
      c.name, e164, c.placeId, c.rating, c.reviews, c.address, c.website, e164, existing.id,
    );
    return get<ProviderRow>('SELECT * FROM providers WHERE id = ?', existing.id)!;
  }
  const res = run(
    `INSERT INTO providers (name, phone_e164, source, place_id, rating_google, reviews_google, address, website)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    c.name, e164, c.source, c.placeId, c.rating, c.reviews, c.address, c.website,
  );
  return get<ProviderRow>('SELECT * FROM providers WHERE id = ?', Number(res.lastInsertRowid))!;
}

// ---------- fallback: busca web do Claude, em dois passos ----------
const SEARCH_SYSTEM = `Tu é um pesquisador que encontra prestadores de serviço locais no Brasil. Usa a busca na web pra achar profissionais reais que atendem na região pedida, de preferência com perfil no Google Maps, site próprio ou anúncios em sites de serviços. Pra cada um, informa nome, telefone com DDD (de preferência celular/WhatsApp), nota e número de avaliações no Google se aparecer, endereço ou região de atendimento, site e a fonte (URL). Não inventa telefone: só lista quem tem telefone encontrado na busca. Faz buscas simples e diretas (ex.: "eletricista Porto Alegre telefone whatsapp") e lê os resultados como vierem; não precisa filtrar com código. Se a busca chegar no limite, lista o que já achou em vez de desistir.`;

const EXTRACT_SYSTEM = 'Extrai dados estruturados de um texto. Não inventa nada que não esteja no texto; usa null quando faltar.';

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    prestadores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nome: { type: 'string' },
          telefone: { type: 'string' },
          nota: { type: ['number', 'null'] },
          avaliacoes: { type: ['integer', 'null'] },
          endereco: { type: ['string', 'null'] },
          site: { type: ['string', 'null'] },
          fonte: { type: ['string', 'null'] },
        },
        required: ['nome', 'telefone', 'nota', 'avaliacoes', 'endereco', 'site', 'fonte'],
        additionalProperties: false,
      },
    },
  },
  required: ['prestadores'],
  additionalProperties: false,
};

async function searchWeb(profissao: string, bairro: string, cidade: string, quantos: number): Promise<Candidate[]> {
  // passo 1: pesquisa com web_search (server tool; pause_turn tratado no runTurn)
  // Pesquisa pela cidade inteira: restringir ao bairro quase não acha ninguém com telefone publicado.
  const step1: MessageParam[] = [{
    role: 'user',
    content:
      `Encontra até ${quantos} ${profissao}s que atendam em ${cidade}` +
      (bairro ? ` (de preferência perto do bairro ${bairro}, mas não precisa ser do bairro)` : '') +
      `. Lista cada um com nome, telefone com DDD, nota e avaliações no Google (se houver), endereço/região, site e fonte.`,
  }];
  const r1 = await runTurn({
    model: MODELS.busca,
    system: SEARCH_SYSTEM,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8, user_location: { type: 'approximate', country: 'BR', city: cidade } }],
    messages: step1,
    effort: 'medium',
    maxTokens: 16000,
  });
  const found = r1.appended
    .flatMap((m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content as Array<{ type: string; text?: string }>)))
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim();
  console.log(`[F2] pesquisa web: ${found.length} caracteres de texto. Início: ${found.slice(0, 600).replace(/\s+/g, ' ')}`);
  if (!found) return [];

  // passo 2: extração estruturada (sem tools, output_config.format)
  const r2 = await runTurn({
    model: MODELS.busca,
    system: EXTRACT_SYSTEM,
    messages: [{ role: 'user', content: `Extrai a lista de prestadores deste texto:\n\n${found}` }],
    effort: 'medium',
    maxTokens: 16000,
    format: { type: 'json_schema', schema: EXTRACT_SCHEMA },
  });
  let parsed: { prestadores?: Array<{ nome: string; telefone: string; nota: number | null; avaliacoes: number | null; endereco: string | null; site: string | null }> };
  try {
    parsed = JSON.parse(textOf(r2.message));
  } catch {
    console.warn('[F2] extração não veio em JSON');
    return [];
  }
  return (parsed.prestadores ?? [])
    .filter((p) => p.telefone)
    .map((p): Candidate => ({
      name: p.nome,
      phone: p.telefone,
      rating: typeof p.nota === 'number' ? p.nota : null,
      reviews: typeof p.avaliacoes === 'number' ? p.avaliacoes : null,
      address: p.endereco,
      website: p.site,
      placeId: null,
      source: 'web',
    }))
    .filter((c) => c.rating == null || c.rating >= 4.0);
}

/** Usado pelo disparo: providers ainda não validados. */
export function unvalidatedSelected(requestId: number) {
  return all<{ rp_id: number; provider_id: number; phone_e164: string }>(
    `SELECT rp.id AS rp_id, p.id AS provider_id, p.phone_e164 FROM request_providers rp JOIN providers p ON p.id = rp.provider_id
     WHERE rp.request_id = ? AND rp.selected = 1 AND rp.status = 'sugerido' AND p.wa_jid IS NULL`,
    requestId,
  );
}
