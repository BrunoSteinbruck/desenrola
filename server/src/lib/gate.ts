// Trava opcional do site inteiro (pré-lançamento): com SITE_PASSWORD, o navegador pede usuário/senha (Basic).
// Desde a F2 cada cliente entra com o celular e o admin tem senha própria; isto só esconde o site antes de abrir.
// O webhook da Twilio e o health ficam de fora.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const OPEN = ['/webhooks/', '/api/health'];

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function registerSiteGate(app: FastifyInstance) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return;
  app.addHook('onRequest', async (req, reply) => {
    if (OPEN.some((p) => req.url.startsWith(p))) return;
    const h = req.headers.authorization ?? '';
    const given = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':') : '';
    if (given && same(given, password)) return;
    return reply.code(401).header('www-authenticate', 'Basic realm="Desenrola", charset="UTF-8"').send({ error: 'Senha necessária' });
  });
}
