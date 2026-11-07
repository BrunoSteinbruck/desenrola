// F4: recrutamento — leads com demanda primeiro, convite pronto, status, e "Cadastrar" vira profissional + boas_vindas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'desenrola-test-'));
for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM', 'WHATSAPP_WEBHOOK_URL', 'ANTHROPIC_API_KEY']) delete process.env[k];

const Fastify = (await import('fastify')).default;
const { get, run, now } = await import('../src/db.ts');
const { registerAdminRoutes } = await import('../src/marketplace/admin-routes.ts');
const app = Fastify();
await registerAdminRoutes(app);

function lead(name: string, phone: string, category: string, demand = 0) {
  const id = Number(run("INSERT INTO providers (name, phone_e164, source, rating_google, reviews_google, lead_demand) VALUES (?, ?, 'web', 4.7, 30, ?)", name, phone, demand).lastInsertRowid);
  run("INSERT INTO provider_areas (provider_id, category_key, category, city_key, city, neighborhood, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'porto alegre', 'Porto Alegre', 'Cidade Baixa', ?, ?)", id, category.toLowerCase(), category, now(), now());
  return id;
}

const a = lead('Chris Tec Assistência', '5551989157257', 'técnico em máquina de lavar', 3);
const b = lead('Brasmatek', '5551998346688', 'técnico em máquina de lavar', 0);
lead('Elétrica Moinhos', '5551977001122', 'eletricista', 1);
const ts = now();
for (let i = 0; i < 2; i++) run("INSERT INTO requests (status, category, city, neighborhood, created_at, updated_at) VALUES ('sem_prestadores', 'técnico em máquina de lavar', 'Porto Alegre', 'Cidade Baixa', ?, ?)", ts, ts);

test('demanda sem profissional e leads com quem os clientes quiseram chamar primeiro', async () => {
  const r = (await app.inject('/api/admin/recruiting')).json();
  assert.equal(r.demand[0].category, 'técnico em máquina de lavar');
  assert.equal(r.demand[0].n, 2);
  assert.equal(r.demand[0].registered, 0);
  assert.equal(r.demand[0].leads, 2);
  assert.equal(r.leads[0].id, a, 'mais demanda primeiro');
  assert.match(r.leads[0].invite_text, /Oi, Chris! .* 3 clientes tentaram te chamar pelo Desenrola/);
  const f = (await app.inject('/api/admin/recruiting?category=eletricista')).json();
  assert.deepEqual(f.leads.map((l: { name: string }) => l.name), ['Elétrica Moinhos']);
});

test('status do convite', async () => {
  const r = await app.inject({ method: 'PUT', url: `/api/admin/leads/${b}`, payload: { lead_status: 'convidado', note: 'liguei, vai pensar' } });
  assert.equal(r.statusCode, 200);
  const l = (await app.inject('/api/admin/recruiting?status=convidado')).json().leads;
  assert.deepEqual(l.map((x: { id: number; lead_note: string }) => [x.id, x.lead_note]), [[b, 'liguei, vai pensar']]);
});

test('Cadastrar: lead vira profissional convidado e sai da lista de leads; boas_vindas na fila', async () => {
  const r = await app.inject({ method: 'POST', url: `/api/admin/leads/${a}/promote`, payload: { categories: 'técnico em máquina de lavar', city: 'Porto Alegre', neighborhoods: 'Cidade Baixa, Bom Fim' } });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().id, a, 'mesmo registro');
  assert.equal(get<{ status: string }>('SELECT status FROM providers WHERE id = ?', a)!.status, 'convidado');
  assert.equal(get<{ template_key: string }>("SELECT template_key FROM wa_outbox WHERE to_phone = '5551989157257'")!.template_key, 'boas_vindas');
  assert.ok(!(await app.inject('/api/admin/recruiting')).json().leads.some((l: { id: number }) => l.id === a));
  assert.equal((await app.inject({ method: 'POST', url: `/api/admin/leads/${a}/promote`, payload: { categories: 'x', city: 'Porto Alegre' } })).statusCode, 404);
  await app.close();
});
