// F2: login por código no WhatsApp, isolamento entre clientes (rotas e SSE) e admin com senha.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'desenrola-test-'));
process.env.ADMIN_PASSWORD = 'senha-admin';
for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM', 'WHATSAPP_WEBHOOK_URL', 'ANTHROPIC_API_KEY', 'SITE_PASSWORD']) delete process.env[k];

const { buildApp } = await import('../src/app.ts');
const { get, run, now } = await import('../src/db.ts');
const { getContact } = await import('../src/channel/store.ts');
const app = await buildApp();

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];

async function login(phone: string, consent = true) {
  const r1 = await app.inject({ method: 'POST', url: '/api/auth/request-code', payload: { phone } });
  assert.equal(r1.statusCode, 200, r1.body);
  const code = r1.json().dev_code as string;
  assert.match(code, /^\d{6}$/);
  const r2 = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { phone, code, consent } });
  assert.equal(r2.statusCode, 200, r2.body);
  return { cookie: cookieOf(r2), me: r2.json() };
}

test('sem login vira visitante (cookie); visitante conversa mas não avisa profissional', async () => {
  const r = await app.inject('/api/settings');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().is_guest, true);
  assert.equal(r.json().user_phone, '');
  const guest = cookieOf(r);
  assert.match(guest, /^ds_session=/);
  assert.deepEqual((await app.inject({ url: '/api/requests', headers: { cookie: guest } })).json(), []);
  const ts = now();
  const id = Number(run("INSERT INTO requests (status, client_id, title, category, created_at, updated_at) VALUES ('escolhendo', ?, 'Do visitante', 'eletricista', ?, ?)", r.json().id, ts, ts).lastInsertRowid);
  const d = await app.inject({ method: 'POST', url: `/api/requests/${id}/dispatch`, headers: { cookie: guest }, payload: {} });
  assert.equal(d.statusCode, 409);
  assert.equal(d.json().code, 'login_required');
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  assert.equal((await app.inject('/api/admin/providers')).statusCode, 401);
});

test('visitante confirma o celular: número novo vira o cliente e mantém os pedidos', async () => {
  const g = await app.inject('/api/settings');
  const cookie = cookieOf(g);
  const ts = now();
  const id = Number(run("INSERT INTO requests (status, client_id, title, created_at, updated_at) VALUES ('diagnostico', ?, 'Antes do login', ?, ?)", g.json().id, ts, ts).lastInsertRowid);
  const code = (await app.inject({ method: 'POST', url: '/api/auth/request-code', headers: { cookie }, payload: { phone: '51991110040' } })).json().dev_code;
  const v = await app.inject({ method: 'POST', url: '/api/auth/verify', headers: { cookie }, payload: { phone: '51991110040', code, consent: true } });
  assert.equal(v.json().is_guest, false);
  assert.equal(v.json().id, g.json().id, 'mesmo cliente');
  const newCookie = cookieOf(v);
  assert.notEqual(newCookie, cookie, 'sessão nova no login');
  assert.equal((await app.inject({ url: '/api/requests', headers: { cookie } })).json().length, 0, 'cookie de visitante antigo não vale mais (vira outro visitante)');
  assert.deepEqual((await app.inject({ url: '/api/requests', headers: { cookie: newCookie } })).json().map((r: { id: number }) => r.id), [id]);
});

test('visitante entra com número que já tem conta: pedidos passam pra conta e o visitante some', async () => {
  const owner = await login('51991110050');
  const g = await app.inject('/api/settings');
  const cookie = cookieOf(g);
  const ts = now();
  const id = Number(run("INSERT INTO requests (status, client_id, title, created_at, updated_at) VALUES ('diagnostico', ?, 'Feito em outro aparelho', ?, ?)", g.json().id, ts, ts).lastInsertRowid);
  const code = (await app.inject({ method: 'POST', url: '/api/auth/request-code', headers: { cookie }, payload: { phone: '51991110050' } })).json().dev_code;
  const v = await app.inject({ method: 'POST', url: '/api/auth/verify', headers: { cookie }, payload: { phone: '51991110050', code, consent: true } });
  assert.equal(v.json().id, owner.me.id);
  assert.ok((await app.inject({ url: '/api/requests', headers: { cookie: owner.cookie } })).json().some((r: { id: number }) => r.id === id));
  assert.equal(get('SELECT 1 FROM clients WHERE id = ?', g.json().id), undefined);
});

test('código: vai pelo template de autenticação, errado não entra, 5 tentativas no máximo', async () => {
  const phone = '(51) 99111-0001';
  const r = await app.inject({ method: 'POST', url: '/api/auth/request-code', payload: { phone } });
  const code = r.json().dev_code;
  const out = get<{ template_key: string; payload_json: string }>("SELECT template_key, payload_json FROM wa_outbox WHERE to_phone = '5551991110001' ORDER BY id DESC LIMIT 1")!;
  assert.equal(out.template_key, 'codigo_verificacao');
  assert.equal(JSON.parse(out.payload_json).vars['1'], code);
  assert.ok(!get("SELECT 1 FROM otp_codes WHERE code_hash LIKE ?", `%${code}%`), 'código não fica em texto puro');

  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  for (let i = 0; i < 5; i++) {
    const v = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { phone, code: wrong, consent: true } });
    assert.equal(v.json().code, 'wrong_code');
  }
  const blocked = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { phone, code, consent: true } });
  assert.equal(blocked.statusCode, 429, 'nem o certo entra depois de 5 erros');
});

test('limite de pedidos de código por número', async () => {
  const phone = '51991110002';
  for (let i = 0; i < 3; i++) assert.equal((await app.inject({ method: 'POST', url: '/api/auth/request-code', payload: { phone } })).statusCode, 200);
  const r = await app.inject({ method: 'POST', url: '/api/auth/request-code', payload: { phone } });
  assert.equal(r.statusCode, 429);
});

test('código expirado não vale', async () => {
  const phone = '51991110003';
  const code = (await app.inject({ method: 'POST', url: '/api/auth/request-code', payload: { phone } })).json().dev_code;
  run("UPDATE otp_codes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE phone = '5551991110003'");
  const r = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { phone, code, consent: true } });
  assert.equal(r.json().code, 'expired');
});

test('dois clientes: cada um só vê e mexe nos próprios pedidos', async () => {
  const a = await login('51991110010');
  const b = await login('51991110020', false);
  assert.equal(a.me.onboarding_done, false);
  // opt-in só de quem marcou
  assert.match(getContact('5551991110010')!.opt_in_text!, /checkbox no site/);
  assert.equal(getContact('5551991110020')?.opt_in_at ?? null, null);

  const put = await app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie: a.cookie }, payload: { user_name: 'Ana', user_neighborhood: 'Bom Fim', onboarding_done: true } });
  assert.equal(put.json().user_name, 'Ana');

  // pedido de A (direto no banco: sem gastar API com o diagnóstico)
  const ts = now();
  const reqA = Number(run("INSERT INTO requests (status, client_id, title, created_at, updated_at) VALUES ('diagnostico', ?, 'Pedido da Ana', ?, ?)", a.me.id, ts, ts).lastInsertRowid);
  run("INSERT INTO messages (request_id, role, content, created_at) VALUES (?, 'user', 'oi', ?)", reqA, ts);

  const listA = (await app.inject({ url: '/api/requests', headers: { cookie: a.cookie } })).json();
  const listB = (await app.inject({ url: '/api/requests', headers: { cookie: b.cookie } })).json();
  assert.deepEqual(listA.map((r: { id: number }) => r.id), [reqA]);
  assert.deepEqual(listB, []);

  assert.equal((await app.inject({ url: `/api/requests/${reqA}`, headers: { cookie: a.cookie } })).statusCode, 200);
  for (const [method, url] of [
    ['GET', `/api/requests/${reqA}`],
    ['POST', `/api/requests/${reqA}/cancel`],
    ['POST', `/api/requests/${reqA}/search`],
    ['POST', `/api/requests/${reqA}/dispatch`],
    ['POST', `/api/requests/${reqA}/quotes/1/approve`],
  ] as const) {
    const r = await app.inject({ method, url, headers: { cookie: b.cookie }, payload: method === 'POST' ? {} : undefined });
    assert.equal(r.statusCode, 404, `${method} ${url} de outro cliente`);
  }
  assert.equal(get<{ status: string }>('SELECT status FROM requests WHERE id = ?', reqA)!.status, 'diagnostico', 'B não cancelou o pedido de A');

  // logout derruba a sessão
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: b.cookie } });
  const after = await app.inject({ url: '/api/requests', headers: { cookie: b.cookie } });
  assert.equal(after.json().length, 0);
  assert.match(String(after.headers['set-cookie']), /ds_session=/, 'sessão encerrada: vira visitante novo');
});

test('admin: senha errada não entra; certa entra; sessão de cliente não abre o admin', async () => {
  const c = await login('51991110030');
  assert.equal((await app.inject({ url: '/api/admin/providers', headers: { cookie: c.cookie } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'errada' } })).statusCode, 401);
  const ok = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'senha-admin' } });
  assert.equal(ok.statusCode, 200);
  const adm = cookieOf(ok);
  assert.equal((await app.inject({ url: '/api/admin/providers', headers: { cookie: adm } })).statusCode, 200);
  // e o admin não vira cliente
  const asClient = await app.inject({ url: '/api/requests', headers: { cookie: adm } });
  assert.deepEqual(asClient.json(), [], 'cookie de admin não é cliente (vira visitante vazio)');
  await app.close();
});
