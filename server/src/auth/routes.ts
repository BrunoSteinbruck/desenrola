// Login por código no WhatsApp (cliente) e por senha (admin). Toda rota /api/* passa por aqui.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { channel, enqueue, OutboxError } from '../channel/index.ts';
import { recordOptIn } from '../channel/store.ts';
import { toE164BR } from '../services/phone.ts';
import {
  AuthError, clientView, createGuest, createSession, deleteSession, getClient, issueCode, loginClient, SESSION_DAYS, sessionFor, verifyCode, type ClientRow,
} from './clients.ts';

declare module 'fastify' {
  interface FastifyRequest {
    client?: ClientRow;
    isAdmin?: boolean;
  }
}

const CLIENT_COOKIE = 'ds_session';
const ADMIN_COOKIE = 'ds_admin';
export const CONSENT_TEXT = 'Quero receber pelo WhatsApp os avisos dos meus pedidos (orçamentos e perguntas dos profissionais).';

const prod = () => process.env.NODE_ENV === 'production';

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function setCookie(reply: FastifyReply, name: string, value: string, maxAgeDays: number) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.round(maxAgeDays * 86400)}`];
  if (prod()) attrs.push('Secure');
  reply.header('set-cookie', attrs.join('; '));
}

/** Rotas abertas (sem login). O resto de /api exige sessão de cliente; /api/admin exige sessão de admin. */
const PUBLIC = ['/api/auth/', '/api/pro/', '/api/health', '/api/admin/login'];

/** Em dev, sem ADMIN_PASSWORD, qualquer senha entra no admin. Em produção a senha é obrigatória. */
export function adminPasswordOk(given: string) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return !prod();
  const a = Buffer.from(given);
  const b = Buffer.from(pw);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function registerAuth(app: FastifyInstance) {
  if (prod() && !process.env.ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD é obrigatória em produção (protege o /admin).');

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (PUBLIC.some((p) => url.startsWith(p))) return;
    if (url.startsWith('/api/dev/') && !prod()) return;
    if (url.startsWith('/api/admin/')) {
      const s = sessionFor(readCookie(req, ADMIN_COOKIE));
      if (s?.is_admin) {
        req.isAdmin = true;
        return;
      }
      return reply.code(401).send({ error: 'Entra com a senha do admin', code: 'admin_required' });
    }
    const s = sessionFor(readCookie(req, CLIENT_COOKIE));
    let c = s?.client_id ? getClient(s.client_id) : undefined;
    if (!c) {
      // sem sessão: vira visitante (cookie). Celular só quando for pedir orçamento.
      c = createGuest();
      setCookie(reply, CLIENT_COOKIE, createSession(c.id), SESSION_DAYS);
    }
    req.client = c;
  });

  // ---------- cliente ----------
  const phoneSchema = z.string().trim().min(8).max(30);

  app.post('/api/auth/request-code', async (req, reply) => {
    const b = z.object({ phone: phoneSchema }).parse(req.body);
    const phone = toE164BR(b.phone);
    if (!phone) return reply.code(400).send({ error: 'Celular inválido. Usa DDD + número, ex.: (51) 99999-8888.' });
    try {
      const code = issueCode(phone, req.ip ?? null);
      enqueue({ to: phone, template: 'codigo_verificacao', vars: { codigo: code }, ref: 'login' });
      // sem Twilio (dev), o código aparece na tela pra dar pra testar; nunca em produção
      return { ok: true, ...(!channel.real && !prod() ? { dev_code: code } : {}) };
    } catch (e) {
      if (e instanceof AuthError) return reply.code(e.httpStatus).send({ error: e.message, code: e.code });
      if (e instanceof OutboxError && e.code === 'opt_out') {
        return reply.code(409).send({ error: 'Esse número pediu pra não receber mensagens do Desenrola. Manda VOLTAR pro nosso WhatsApp e tenta de novo.', code: 'opt_out' });
      }
      throw e;
    }
  });

  app.post('/api/auth/verify', async (req, reply) => {
    const b = z.object({ phone: phoneSchema, code: z.string().trim().min(4).max(10), consent: z.boolean() }).parse(req.body);
    const phone = toE164BR(b.phone);
    if (!phone) return reply.code(400).send({ error: 'Celular inválido.' });
    try {
      if (!verifyCode(phone, b.code)) return reply.code(400).send({ error: 'Código errado. Confere e tenta de novo.', code: 'wrong_code' });
    } catch (e) {
      if (e instanceof AuthError) return reply.code(e.httpStatus).send({ error: e.message, code: e.code });
      throw e;
    }
    const cur = sessionFor(readCookie(req, CLIENT_COOKIE));
    const c = loginClient(phone, cur?.client_id ?? null);
    if (b.consent) recordOptIn(phone, `checkbox no site: "${CONSENT_TEXT}"`);
    deleteSession(readCookie(req, CLIENT_COOKIE)); // sessão nova no login (a de visitante não vale mais)
    setCookie(reply, CLIENT_COOKIE, createSession(c.id), SESSION_DAYS);
    return clientView(c);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    deleteSession(readCookie(req, CLIENT_COOKIE));
    setCookie(reply, CLIENT_COOKIE, '', 0);
    return { ok: true };
  });

  app.get('/api/me', async (req) => clientView(req.client!));

  // ---------- admin ----------
  app.post('/api/admin/login', async (req, reply) => {
    const { password } = z.object({ password: z.string().max(200) }).parse(req.body ?? {});
    if (!adminPasswordOk(password)) return reply.code(401).send({ error: 'Senha errada', code: 'admin_required' });
    setCookie(reply, ADMIN_COOKIE, createSession(null, true), 7);
    return { ok: true };
  });
  app.get('/api/admin/me', async () => ({ ok: true }));
  app.post('/api/admin/logout', async (req, reply) => {
    deleteSession(readCookie(req, ADMIN_COOKIE));
    setCookie(reply, ADMIN_COOKIE, '', 0);
    return { ok: true };
  });
}
