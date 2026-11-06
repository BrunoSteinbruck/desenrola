// F2 — Buscador: acha prestadores (Google Places ou busca web do Claude), ranqueia e valida WhatsApp.
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  all, get, getRequest, postMessage, run, setRequestStatus, type ProviderRow,
} from '../db.ts';
import { hasPlaces, searchPlaces, type Candidate } from '../services/places.ts';
import { toE164BR } from '../services/phone.ts';
import { checkWhatsApp, isConnected } from '../whatsapp.ts';
import { friendlyError, runTurn, textOf } from './claude.ts';
import { addDiagnosticoNote } from './diagnostico.ts';

const MAX_CHECK = 8;
const MAX_SHOW = 5;

export async function runSearch(requestId: number): Promise<void> {
  const req = getRequest(requestId);
  if (!req || !req.category) return;
  setRequestStatus(requestId, 'buscando');
  const where = [req.neighborhood, req.city].filter(Boolean).join(', ');

  let candidates: Candidate[];
  try {
    candidates = hasPlaces()
      ? await searchPlaces(`${req.category} em ${where}`)
      : await searchWeb(req.category, req.neighborhood ?? '', req.city ?? 'Porto Alegre');
  } catch (err) {
    console.error('[F2] busca falhou', err);
    setRequestStatus(requestId, 'diagnostico');
    const msg = err instanceof Error && err.message.startsWith('Places') ? 'A busca no Google falhou. Tenta de novo em instantes.' : friendlyError(err);
    postMessage(requestId, 'system_event', msg, { kind: 'error' });
    return;
  }

  // normaliza, deduplica por telefone, grava/reaproveita providers
  const seen = new Set<string>();
  const provs: ProviderRow[] = [];
  for (const c of candidates) {
    const e164 = c.phone ? toE164BR(c.phone) : null;
    if (!e164 || seen.has(e164)) continue;
    seen.add(e164);
    provs.push(upsertProvider(c, e164));
  }
  const ranked = provs
    .filter((p) => !p.blocked)
    .map((p) => ({ p, score: score(p) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p)
    .slice(0, MAX_CHECK);

  // valida WhatsApp (se conectado); sem conexão, valida no disparo
  const connected = isConnected();
  const chosen: ProviderRow[] = [];
  let noWa = 0;
  for (const p of ranked) {
    if (chosen.length >= MAX_SHOW) break;
    if (connected && !p.wa_jid) {
      const jid = await checkWhatsApp(p.phone_e164!);
      if (jid === null) { noWa++; continue; }
      if (jid) { run('UPDATE providers SET wa_jid = ? WHERE id = ?', jid, p.id); p.wa_jid = jid; }
    }
    chosen.push(p);
  }

  // helper de dev: o 2º celular do próprio usuário como prestador, sempre no topo
  const devPhone = process.env.DEV_TEST_PROVIDER_PHONE ? toE164BR(process.env.DEV_TEST_PROVIDER_PHONE) : null;
  if (devPhone) {
    const dev = upsertProvider(
      { name: 'Prestador de teste', phone: devPhone, rating: 5, reviews: 1, address: null, website: null, placeId: null, source: 'teste' },
      devPhone,
    );
    if (connected && !dev.wa_jid) {
      const jid = await checkWhatsApp(devPhone);
      if (jid) { run('UPDATE providers SET wa_jid = ? WHERE id = ?', jid, dev.id); dev.wa_jid = jid; }
      else if (jid === null) console.warn('[F2] DEV_TEST_PROVIDER_PHONE não tem WhatsApp');
    }
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
const SEARCH_SYSTEM = `Tu é um pesquisador que encontra prestadores de serviço locais no Brasil. Usa a busca na web pra achar profissionais reais que atendem na região pedida, de preferência com perfil no Google Maps, site próprio ou anúncios em sites de serviços. Pra cada um, informa nome, telefone com DDD (de preferência celular/WhatsApp), nota e número de avaliações no Google se aparecer, endereço ou região de atendimento, site e a fonte (URL). Não inventa telefone: só lista quem tem telefone encontrado na busca.`;

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

async function searchWeb(profissao: string, bairro: string, cidade: string): Promise<Candidate[]> {
  // passo 1: pesquisa com web_search (server tool; pause_turn tratado no runTurn)
  const step1: MessageParam[] = [{
    role: 'user',
    content: `Encontra até 10 ${profissao}s que atendam em ${bairro ? bairro + ', ' : ''}${cidade}. Lista cada um com nome, telefone com DDD, nota e avaliações no Google (se houver), endereço/região, site e fonte.`,
  }];
  const r1 = await runTurn({
    system: SEARCH_SYSTEM,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5, user_location: { type: 'approximate', country: 'BR', city: cidade } }],
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
  if (!found) return [];

  // passo 2: extração estruturada (sem tools, output_config.format)
  const r2 = await runTurn({
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
