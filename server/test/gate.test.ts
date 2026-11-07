// Trava do site por senha (até existir login): webhook e health ficam de fora.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

test('SITE_PASSWORD trava tudo menos webhook e health; produção sem senha não sobe', async () => {
  const { registerSiteGate } = await import('../src/lib/gate.ts');
  process.env.SITE_PASSWORD = 'segredo:com:dois-pontos';
  const app = Fastify();
  registerSiteGate(app);
  app.get('/api/requests', async () => ['ok']);
  app.get('/api/health', async () => ({ ok: true }));
  app.post('/webhooks/whatsapp', async () => 'ok');
  const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

  assert.equal((await app.inject('/api/requests')).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/requests', headers: { authorization: basic('x', 'errada') } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/requests', headers: { authorization: basic('qualquer', 'segredo:com:dois-pontos') } })).statusCode, 200);
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/webhooks/whatsapp' })).statusCode, 200);
  await app.close();

  delete process.env.SITE_PASSWORD;
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  assert.throws(() => registerSiteGate(Fastify()), /SITE_PASSWORD/);
  process.env.NODE_ENV = prev;
});
