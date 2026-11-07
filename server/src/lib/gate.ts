// Trava do site inteiro enquanto o login de verdade (F2) não existe.
// Hoje as rotas não têm dono: qualquer um com a URL veria e mexeria em todos os pedidos.
// Com SITE_PASSWORD, o navegador pede usuário/senha (Basic). O webhook da Twilio e o health ficam de fora.
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
  if (!password) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SITE_PASSWORD é obrigatória em produção até existir login (F2): sem ela o site fica aberto pra qualquer um.');
    }
    return;
  }
  app.addHook('onRequest', async (req, reply) => {
    if (OPEN.some((p) => req.url.startsWith(p))) return;
    const h = req.headers.authorization ?? '';
    const given = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':') : '';
    if (given && same(given, password)) return;
    return reply.code(401).header('www-authenticate', 'Basic realm="Desenrola", charset="UTF-8"').send({ error: 'Senha necessária' });
  });
}
