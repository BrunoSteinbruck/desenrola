// Contatos sugeridos: sem cadastrado → busca (uma vez) → guarda no banco → próximos pedidos saem do banco.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'desenrola-test-'));
for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM', 'WHATSAPP_WEBHOOK_URL', 'ANTHROPIC_API_KEY', 'GOOGLE_MAPS_API_KEY']) delete process.env[k];

const { all, get, run, now } = await import('../src/db.ts');
const { loginClient } = await import('../src/auth/clients.ts');
const offers = await import('../src/marketplace/offers.ts');
const sug = await import('../src/marketplace/suggestions.ts');

let searches = 0;
sug.setSearcherForTests(async (category, _hood, city) => {
  searches++;
  return {
    source: 'web',
    found: [
      { name: `Técnico A (${category}, ${city})`, phone: '(51) 98000-0001', rating: 4.8, reviews: 40, address: 'Cidade Baixa', website: null, placeId: null, source: 'web' },
      { name: 'Técnico B', phone: '51980000002', rating: 4.5, reviews: 12, address: null, website: null, placeId: null, source: 'web' },
      { name: 'Sem telefone', phone: null, rating: 5, reviews: 3, address: null, website: null, placeId: null, source: 'web' },
    ],
  };
});

const client = loginClient('5551977770000');
function newRequest(category: string, city = 'Porto Alegre') {
  const ts = now();
  const id = Number(
    run("INSERT INTO requests (status, client_id, title, summary, category, city, neighborhood, created_at, updated_at) VALUES ('diagnostico', ?, 'Máquina não liga', 'x', ?, ?, 'Cidade Baixa', ?, ?)", client.id, category, city, ts, ts).lastInsertRowid,
  );
  run("INSERT INTO messages (request_id, role, content, created_at) VALUES (?, 'user', 'minha maquina de lavar parou de funcionar, nem liga', ?)", id, ts);
  return id;
}
const waitSuggestions = async (id: number) => {
  for (let i = 0; i < 50; i++) {
    const m = get<{ card_json: string }>("SELECT card_json FROM messages WHERE request_id = ? AND card_json LIKE '%suggestions%'", id);
    if (m) return JSON.parse(m.card_json).items as Array<{ provider_id: number; name: string; wa_url: string }>;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('sem cartão de sugestões');
};

test('sem cadastrado: pesquisa, guarda e mostra com a mensagem pronta', async () => {
  const id = newRequest('técnico em máquina de lavar');
  assert.equal(offers.findProviders(id).count, 0);
  const items = await waitSuggestions(id);
  assert.equal(searches, 1);
  assert.equal(items.length, 2, 'quem não tem telefone fica de fora');
  const url = new URL(items[0].wa_url);
  assert.equal(url.host, 'wa.me');
  assert.match(url.pathname, /^\/555198000000\d$/);
  const text = url.searchParams.get('text')!;
  assert.match(text, /Vi teu contato pelo Desenrola/);
  assert.match(text, /Cidade Baixa/);
  assert.match(text, /Minha maquina de lavar parou de funcionar/);
  assert.equal(get<{ status: string }>('SELECT status FROM requests WHERE id = ?', id)!.status, 'sem_prestadores');
  assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM lead_searches')!.n, 1);
  // guardados como lead: nunca recebem mensagem automática nem entram no matching
  for (const p of all<{ status: string }>("SELECT status FROM providers WHERE name LIKE 'Técnico%'")) assert.equal(p.status, 'lead');
});

test('mesma profissão e cidade de novo: sai do banco, sem pesquisar', async () => {
  const id = newRequest('Técnico em Máquina de Lavar');
  offers.findProviders(id);
  const items = await waitSuggestions(id);
  assert.equal(searches, 1, 'não pesquisou de novo');
  assert.equal(items.length, 2);
});

test('outra cidade pesquisa; busca vazia também fica guardada (por menos tempo)', async () => {
  sug.setSearcherForTests(async () => {
    searches++;
    return { source: 'web', found: [] };
  });
  const id = newRequest('técnico em máquina de lavar', 'Canoas');
  offers.findProviders(id);
  for (let i = 0; i < 50 && !get("SELECT 1 FROM lead_searches WHERE city_key = 'canoas'"); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(searches, 2);
  assert.ok(sug.recentSearch('técnico em máquina de lavar', 'Canoas'));
  run("UPDATE lead_searches SET searched_at = ? WHERE city_key = 'canoas'", new Date(Date.now() - 8 * 24 * 3600_000).toISOString());
  assert.equal(sug.recentSearch('técnico em máquina de lavar', 'Canoas'), null, 'busca vazia expira em 7 dias');
});

test('clique em "Chamar no WhatsApp" conta como demanda pro recrutamento', () => {
  const p = get<{ id: number }>("SELECT id FROM providers WHERE name = 'Técnico B'")!;
  const id = newRequest('técnico em máquina de lavar');
  assert.equal(sug.recordSuggestionClick(id, p.id), true);
  assert.equal(get<{ lead_demand: number }>('SELECT lead_demand FROM providers WHERE id = ?', p.id)!.lead_demand, 1);
});
