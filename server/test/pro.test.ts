// F1: autocadastro do profissional em /profissional (código no WhatsApp + aceite = opt-in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'desenrola-test-'));
for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM', 'WHATSAPP_WEBHOOK_URL', 'ANTHROPIC_API_KEY', 'SITE_PASSWORD']) delete process.env[k];

const { buildApp } = await import('../src/app.ts');
const { get } = await import('../src/db.ts');
const { getContact } = await import('../src/channel/store.ts');
const { eligibleProviders } = await import('../src/marketplace/providers.ts');
const { inviteText } = await import('../src/marketplace/leads.ts');
const app = await buildApp();

const body = (code: string, extra: Record<string, unknown> = {}) => ({
  name: 'Marcos Silva', phone: '(51) 99222-3333', code, consent: true,
  categories: ['eletricista'], city: 'Porto Alegre', neighborhoods: 'Cidade Baixa, Bom Fim', ...extra,
});

test('sem login: pede código e se cadastra; vira ativo, com opt-in e no matching', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/pro/request-code', payload: { phone: '51992223333' } });
  assert.equal(r.statusCode, 200, r.body);
  const code = r.json().dev_code;
  const no = await app.inject({ method: 'POST', url: '/api/pro/register', payload: body(code, { consent: false }) });
  assert.equal(no.statusCode, 400, 'sem aceite não cadastra');
  const wrong = await app.inject({ method: 'POST', url: '/api/pro/register', payload: body('000000') });
  assert.equal(wrong.json().code, 'wrong_code');
  const ok = await app.inject({ method: 'POST', url: '/api/pro/register', payload: body(code) });
  assert.equal(ok.statusCode, 200, ok.body);
  const p = get<{ status: string; categories: string }>('SELECT status, categories FROM providers WHERE id = ?', ok.json().id)!;
  assert.deepEqual([p.status, p.categories], ['ativo', 'eletricista']);
  assert.match(getContact('5551992223333')!.opt_in_text!, /cadastro em \/profissional/);
  assert.deepEqual(eligibleProviders('eletricista', 'Porto Alegre', 'Bom Fim').map((x) => x.id), [ok.json().id]);
  // código já usado não vale de novo
  assert.equal((await app.inject({ method: 'POST', url: '/api/pro/register', payload: body(code) })).statusCode, 400);
});

test('convite do recrutamento leva o link do cadastro', () => {
  assert.match(inviteText({ name: 'Ana Souza', category: 'encanador', city: 'Porto Alegre', demand: 2 }), /\/profissional$/);
});

test('rotas do cliente seguem fechadas pro /api/pro', async () => {
  const r = await app.inject('/api/admin/providers');
  assert.equal(r.statusCode, 401);
  await app.close();
});
