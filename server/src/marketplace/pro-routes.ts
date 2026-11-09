// F1 — o profissional se cadastra sozinho em /profissional: nome, celular (código no WhatsApp),
// o que faz e onde atende, e o aceite explícito de receber pedidos (vira a prova do opt-in).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { channel, enqueue, OutboxError } from '../channel/index.ts';
import { recordOptIn } from '../channel/store.ts';
import { AuthError, issueCode, verifyCode } from '../auth/clients.ts';
import { bus } from '../events.ts';
import { toE164BR } from '../services/phone.ts';
import { ProviderError, setProviderStatus, splitList, upsertProviderFromAdmin } from './providers.ts';

export const PRO_CONSENT_TEXT = 'Quero receber pedidos de serviço do Desenrola pelo WhatsApp.';

const prod = () => process.env.NODE_ENV === 'production';

export async function registerProRoutes(app: FastifyInstance) {
  app.post('/api/pro/request-code', async (req, reply) => {
    const b = z.object({ phone: z.string().trim().min(8).max(30) }).parse(req.body);
    const phone = toE164BR(b.phone);
    if (!phone) return reply.code(400).send({ error: 'Celular inválido. Usa DDD + número, ex.: (51) 99999-8888.' });
    try {
      const code = issueCode(phone, req.ip ?? null);
      enqueue({ to: phone, template: 'codigo_verificacao', vars: { codigo: code }, ref: 'pro-signup' });
      return { ok: true, ...(!channel.real && !prod() ? { dev_code: code } : {}) };
    } catch (e) {
      if (e instanceof AuthError) return reply.code(e.httpStatus).send({ error: e.message, code: e.code });
      if (e instanceof OutboxError && e.code === 'opt_out') {
        return reply.code(409).send({ error: 'Esse número pediu pra não receber mensagens do Desenrola. Manda VOLTAR pro nosso WhatsApp e tenta de novo.' });
      }
      throw e;
    }
  });

  app.post('/api/pro/register', async (req, reply) => {
    const b = z
      .object({
        name: z.string().trim().min(2).max(120),
        phone: z.string().trim().min(8).max(30),
        code: z.string().trim().min(4).max(10),
        consent: z.literal(true, { message: 'Precisa aceitar receber os pedidos pelo WhatsApp.' }),
        categories: z.union([z.string(), z.array(z.string())]),
        city: z.string().trim().min(2).max(100),
        neighborhoods: z.union([z.string(), z.array(z.string())]).default([]),
        bio: z.string().trim().max(500).nullish(),
      })
      .parse(req.body);
    const phone = toE164BR(b.phone);
    if (!phone) return reply.code(400).send({ error: 'Celular inválido.' });
    const categories = Array.isArray(b.categories) ? b.categories : splitList(b.categories);
    if (!categories.length) return reply.code(400).send({ error: 'Escolhe pelo menos um serviço.' });
    try {
      if (!verifyCode(phone, b.code)) return reply.code(400).send({ error: 'Código errado. Confere e tenta de novo.', code: 'wrong_code' });
    } catch (e) {
      if (e instanceof AuthError) return reply.code(e.httpStatus).send({ error: e.message, code: e.code });
      throw e;
    }
    try {
      const p = upsertProviderFromAdmin({
        name: b.name,
        phone,
        categories,
        city: b.city,
        neighborhoods: Array.isArray(b.neighborhoods) ? b.neighborhoods : splitList(b.neighborhoods),
        bio: b.bio ?? null,
        notes: 'Cadastro pelo site (/profissional)',
      });
      // código confirmado (o número é dele) + aceite marcado = opt-in com prova
      recordOptIn(phone, `cadastro em /profissional: "${PRO_CONSENT_TEXT}"`);
      if (p.status !== 'bloqueado') setProviderStatus(p.id, 'ativo');
      bus.publish({ type: 'admin.providers' });
      return { ok: true, id: p.id };
    } catch (e) {
      if (e instanceof ProviderError) return reply.code(e.httpStatus).send({ error: e.message });
      throw e;
    }
  });
}
