// Monta o servidor (rotas, login, SSE, front) sem subir: usado pelo index.ts e pelos testes.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { bus, type ServerEvent } from './events.ts';
import {
  get, getRequest, getRp, getSetting, listRequestsView, now, paymentView, postMessage, publicSettings, requestView, run,
  setSetting, updateRp,
} from './db.ts';
import { applyNewAddress, runDiagnostico } from './agents/diagnostico.ts';
import { pushUserReply, recoverNegotiations } from './agents/negociador.ts';
import { approve, cancelRequest, FlowError, reject } from './agents/relator.ts';
import { rate } from './agents/followup.ts';
import { closeHandoff, dispatch, findProviders, OfferError, onInbound, openHandoff } from './marketplace/offers.ts';
import { onProviderConsent, ProviderError } from './marketplace/providers.ts';
import { registerAdminRoutes } from './marketplace/admin-routes.ts';
import { recordSuggestionClick } from './marketplace/suggestions.ts';
import { registerProRoutes } from './marketplace/pro-routes.ts';
import { startScheduler } from './services/scheduler.ts';
import { hasPlaces } from './services/places.ts';
import { toE164BR } from './services/phone.ts';
import { normalizePlace } from './services/geo.ts';
import { hasClaude } from './agents/claude.ts';
import { channel, onConsentChange, onInboundMessage, registerWhatsAppRoutes, startChannel } from './channel/index.ts';
import { registerSiteGate } from './lib/gate.ts';
import { clientView, getClient, updateClient } from './auth/clients.ts';
import { registerAuth } from './auth/routes.ts';

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // atrás do proxy do Render: confia em 1 salto (IP real do cliente pro rate limit)
    trustProxy: process.env.NODE_ENV === 'production' ? (_addr: string, hop: number) => hop < 1 : false,
  });
  registerSiteGate(app);
  await registerAuth(app);

  // ---------- erros ----------
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Dados inválidos', details: err.issues });
    if (err instanceof FlowError) {
      const code = (err as FlowError & { code?: string }).code;
      return reply.code(err.httpStatus).send({ error: err.message, ...(code ? { code } : {}) });
    }
    if (err instanceof OfferError) return reply.code(err.httpStatus).send({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    if (err instanceof ProviderError) return reply.code(err.httpStatus).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Erro interno' });
  });

  const idParam = z.object({ id: z.coerce.number().int().positive() });
  const rpParam = idParam.extend({ rpId: z.coerce.number().int().positive() });

  /** Pedido do cliente logado. Pedido de outro cliente = 404 (nem confirma que existe). */
  function requireRequest(req: FastifyRequest, id: number) {
    const r = getRequest(id);
    if (!r || r.client_id !== req.client!.id) throw new FlowError('Pedido não encontrado', 404);
    return r;
  }
  function requireRp(req: FastifyRequest, requestId: number, rpId: number) {
    requireRequest(req, requestId);
    const rp = getRp(rpId);
    if (!rp || rp.request_id !== requestId) throw new FlowError('Profissional não encontrado nesse pedido', 404);
    return rp;
  }
  const bg = (p: Promise<unknown>) => void p.catch((err) => app.log.error(err));

  // ---------- pedidos (sempre do cliente logado) ----------
  app.get('/api/requests', async (req) => listRequestsView(req.client!.id));

  app.post('/api/requests', async (req, reply) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(req.body);
    const c = req.client!;
    const ts = now();
    const res = run(
      "INSERT INTO requests (status, client_id, city, neighborhood, created_at, updated_at) VALUES ('diagnostico', ?, ?, ?, ?, ?)",
      c.id, c.city || null, c.neighborhood || null, ts, ts,
    );
    const id = Number(res.lastInsertRowid);
    postMessage(id, 'user', text);
    bg(runDiagnostico(id, text));
    return reply.code(201).send({ id });
  });

  app.get('/api/requests/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    requireRequest(req, id);
    return requestView(id)!;
  });

  app.post('/api/requests/:id/messages', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ text: z.string().trim().min(1).max(4000), providerId: z.coerce.number().int().positive().nullish() }).parse(req.body);
    requireRequest(req, id);
    if (body.providerId) {
      // providerId = rpId (id da lista `providers`); aceita também o provider_id
      const rp =
        get<{ id: number }>('SELECT id FROM request_providers WHERE id = ? AND request_id = ?', body.providerId, id) ??
        get<{ id: number }>('SELECT id FROM request_providers WHERE provider_id = ? AND request_id = ?', body.providerId, id);
      if (!rp) throw new FlowError('Profissional não encontrado nesse pedido', 404);
      postMessage(id, 'user', body.text);
      pushUserReply(rp.id, body.text);
    } else {
      postMessage(id, 'user', body.text);
      bg(runDiagnostico(id, body.text));
    }
    return { ok: true };
  });

  // "Ver <profissão> da região" = matching no nosso banco de prestadores (não manda nada ainda)
  app.post('/api/requests/:id/search', async (req) => {
    const { id } = idParam.parse(req.params);
    requireRequest(req, id);
    return findProviders(id);
  });

  app.post('/api/requests/:id/providers/:rpId', async (req) => {
    const { id, rpId } = rpParam.parse(req.params);
    const { selected } = z.object({ selected: z.boolean() }).parse(req.body);
    const rp = requireRp(req, id, rpId);
    if (getRequest(id)!.status !== 'escolhendo' || rp.status !== 'sugerido') throw new FlowError('A seleção não pode mais mudar', 409);
    updateRp(rpId, { selected: selected ? 1 : 0 });
    return { ok: true };
  });

  // avisa os selecionados pelo template pedido_novo
  app.post('/api/requests/:id/dispatch', async (req) => {
    const { id } = idParam.parse(req.params);
    requireRequest(req, id);
    return { ok: true, ...dispatch(id) };
  });

  app.post('/api/requests/:id/cancel', async (req) => {
    const { id } = idParam.parse(req.params);
    requireRequest(req, id);
    cancelRequest(id);
    return { ok: true };
  });

  app.post('/api/requests/:id/quotes/:rpId/approve', async (req) => {
    const { id, rpId } = rpParam.parse(req.params);
    requireRp(req, id, rpId);
    approve(id, rpId);
    return { ok: true };
  });
  app.post('/api/requests/:id/quotes/:rpId/reject', async (req) => {
    const { id, rpId } = rpParam.parse(req.params);
    requireRp(req, id, rpId);
    reject(id, rpId);
    return { ok: true };
  });
  app.post('/api/requests/:id/quotes/:rpId/reply', async (req) => {
    const { id, rpId } = rpParam.parse(req.params);
    const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(req.body);
    requireRp(req, id, rpId);
    postMessage(id, 'user', text);
    pushUserReply(rpId, text);
    return { ok: true };
  });

  // contatos sugeridos: o cliente tocou em "Chamar no WhatsApp" (conta como demanda pro recrutamento)
  app.post('/api/requests/:id/suggestions/:providerId/click', async (req) => {
    const { id, providerId } = z.object({ id: z.coerce.number().int().positive(), providerId: z.coerce.number().int().positive() }).parse(req.params);
    requireRequest(req, id);
    return { ok: recordSuggestionClick(id, providerId) };
  });

  app.post('/api/requests/:id/rating', async (req) => {
    const { id } = idParam.parse(req.params);
    requireRequest(req, id);
    const b = z.object({
      providerId: z.coerce.number().int().positive(),
      stars: z.coerce.number().int().min(1).max(5),
      comment: z.string().max(2000).nullish(),
      serviceDone: z.boolean().optional(),
    }).parse(req.body);
    rate(id, b);
    return { ok: true };
  });

  // ---------- perfil do cliente ----------
  // Corrige cidade/bairro digitados pro nome oficial (usado no onboarding antes do mapa)
  app.post('/api/geo/normalize', async (req) => {
    const b = z.object({ city: z.string().trim().max(100), neighborhood: z.string().trim().max(100) }).parse(req.body ?? {});
    return normalizePlace(b.city, b.neighborhood);
  });

  app.get('/api/settings', async (req) => clientView(req.client!));
  app.put('/api/settings', async (req) => {
    const b = z.object({
      user_name: z.string().trim().max(100).optional(),
      user_city: z.string().trim().max(100).optional(),
      user_neighborhood: z.string().trim().max(100).optional(),
      onboarding_done: z.boolean().optional(),
    }).parse(req.body ?? {});
    const id = req.client!.id;
    const before = getClient(id)!;
    updateClient(id, {
      ...(b.user_name !== undefined ? { name: b.user_name } : {}),
      ...(b.user_city !== undefined ? { city: b.user_city } : {}),
      ...(b.user_neighborhood !== undefined ? { neighborhood: b.user_neighborhood } : {}),
      ...(b.onboarding_done !== undefined ? { onboarding_done: b.onboarding_done ? 1 : 0 } : {}),
    });
    const after = getClient(id)!;
    // mudou o endereço: os pedidos ainda não enviados e o diagnóstico passam a usar o novo
    if (after.city !== before.city || after.neighborhood !== before.neighborhood) applyNewAddress(id, after.city, after.neighborhood);
    return clientView(after);
  });

  app.get('/api/health', async () => ({
    ok: true,
    claude: hasClaude(),
    places: hasPlaces(),
    transcription: !!process.env.OPENAI_API_KEY,
    devTestProvider: !!process.env.DEV_TEST_PROVIDER_PHONE,
    payments: false,
    whatsappOficial: channel.name,
  }));

  // ---------- WhatsApp oficial (V2): webhook da Twilio + rotas de dev ----------
  await registerWhatsAppRoutes(app);
  await registerAdminRoutes(app);
  await registerProRoutes(app);

  // ---------- SSE ----------
  /** Tempo real. Cliente: só eventos dos pedidos dele. Admin: só os do admin. */
  function stream(req: FastifyRequest, reply: FastifyReply, allow: (ev: ServerEvent) => boolean) {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (ev: ServerEvent) => {
      if (!allow(ev)) return;
      const { type, ...data } = ev;
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    res.write('retry: 3000\n\n');
    bus.on('event', send);
    const hb = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(hb);
      bus.off('event', send);
    });
  }
  const ownerCache = new Map<number, number | null>();
  const ownerOf = (requestId: number) => {
    if (!ownerCache.has(requestId)) ownerCache.set(requestId, getRequest(requestId)?.client_id ?? null);
    return ownerCache.get(requestId);
  };
  app.get('/api/stream', (req, reply) => {
    const me = req.client!.id;
    stream(req, reply, (ev) => {
      if (ev.type.startsWith('admin.')) return false;
      if ('requestId' in ev) return ownerOf(ev.requestId) === me;
      return true; // requests.changed: só pede pra recarregar a lista (que já vem filtrada)
    });
  });
  app.get('/api/admin/stream', (req, reply) => stream(req, reply, (ev) => ev.type.startsWith('admin.')));

  // ---------- front (produção) ----------
  const dist = resolve(process.cwd(), 'web/dist');
  if (process.env.NODE_ENV === 'production' && existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'Rota não encontrada' });
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Rota não encontrada' }));
  }
  return app;
}

/** Liga o canal oficial ao marketplace (respostas dos prestadores, opt-in/opt-out). */
export function wireMarketplace() {
  onInboundMessage(onInbound);
  onConsentChange((phone, kind) => {
    onProviderConsent(phone, kind);
    bus.publish({ type: 'admin.providers' });
  });
}
