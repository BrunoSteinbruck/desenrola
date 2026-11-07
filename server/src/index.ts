// Fastify: rotas da API (contrato em PLANO.md §4 + API.md), SSE e web/dist em produção.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { bus, type ServerEvent } from './events.ts';
import {
  get, getRequest, getRp, getSetting, listRequestsView, now, paymentView, postMessage, publicSettings, requestView, run,
  setSetting, updateRp,
} from './db.ts';
import { runDiagnostico } from './agents/diagnostico.ts';
import { runSearch } from './agents/buscador.ts';
import { onManualReply, onProviderMessage, pushUserReply, recoverNegotiations, resume } from './agents/negociador.ts';
import { approve, cancelRequest, FlowError, reject } from './agents/relator.ts';
import { rate } from './agents/followup.ts';
import { dispatch, paymentsEnabled, resumeAfterConnect } from './flow.ts';
import { cancelPending, getPayment, hasMercadoPago, PaymentError, simulatePayment, sweepPayments } from './services/payments.ts';
import { startScheduler } from './services/scheduler.ts';
import { hasPlaces } from './services/places.ts';
import { normalizePlace } from './services/geo.ts';
import { hasClaude } from './agents/claude.ts';
import { connect, hasSavedSession, logout, setWhatsAppHandlers, waState } from './whatsapp.ts';
import { channel, registerWhatsAppRoutes, startChannel } from './channel/index.ts';
import { registerSiteGate } from './lib/gate.ts';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  // atrás do proxy do Render: confia em 1 salto (IP real do cliente pro rate limit)
  trustProxy: process.env.NODE_ENV === 'production' ? (_addr: string, hop: number) => hop < 1 : false,
});
registerSiteGate(app);

// ---------- erros ----------
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) return reply.code(400).send({ error: 'Dados inválidos', details: err.issues });
  if (err instanceof FlowError) {
    const code = (err as FlowError & { code?: string }).code;
    return reply.code(err.httpStatus).send({ error: err.message, ...(code ? { code } : {}) });
  }
  if (err instanceof PaymentError) return reply.code(err.httpStatus).send({ error: err.message, code: err.code });
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
  app.log.error(err);
  return reply.code(500).send({ error: 'Erro interno' });
});

const idParam = z.object({ id: z.coerce.number().int().positive() });
const rpParam = idParam.extend({ rpId: z.coerce.number().int().positive() });

function requireRequest(id: number) {
  const r = getRequest(id);
  if (!r) throw new FlowError('Pedido não encontrado', 404);
  return r;
}
function requireRp(requestId: number, rpId: number) {
  const rp = getRp(rpId);
  if (!rp || rp.request_id !== requestId) throw new FlowError('Prestador não encontrado nesse pedido', 404);
  return rp;
}
const bg = (p: Promise<unknown>) => void p.catch((err) => app.log.error(err));

// ---------- pedidos ----------
app.get('/api/requests', async () => listRequestsView());

app.post('/api/requests', async (req, reply) => {
  const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(req.body);
  const ts = now();
  const res = run("INSERT INTO requests (status, city, created_at, updated_at) VALUES ('diagnostico', ?, ?, ?)", getSetting('user_city') || null, ts, ts);
  const id = Number(res.lastInsertRowid);
  postMessage(id, 'user', text);
  bg(runDiagnostico(id, text));
  return reply.code(201).send({ id });
});

app.get('/api/requests/:id', async (req) => {
  const { id } = idParam.parse(req.params);
  const v = requestView(id);
  if (!v) throw new FlowError('Pedido não encontrado', 404);
  return v;
});

app.post('/api/requests/:id/messages', async (req) => {
  const { id } = idParam.parse(req.params);
  const body = z.object({ text: z.string().trim().min(1).max(4000), providerId: z.coerce.number().int().positive().nullish() }).parse(req.body);
  requireRequest(id);
  if (body.providerId) {
    // providerId = rpId (id da lista `providers`); aceita também o provider_id
    const rp =
      get<{ id: number }>('SELECT id FROM request_providers WHERE id = ? AND request_id = ?', body.providerId, id) ??
      get<{ id: number }>('SELECT id FROM request_providers WHERE provider_id = ? AND request_id = ?', body.providerId, id);
    if (!rp) throw new FlowError('Prestador não encontrado nesse pedido', 404);
    postMessage(id, 'user', body.text);
    pushUserReply(rp.id, body.text);
  } else {
    postMessage(id, 'user', body.text);
    bg(runDiagnostico(id, body.text));
  }
  return { ok: true };
});

app.post('/api/requests/:id/search', async (req) => {
  const { id } = idParam.parse(req.params);
  const r = requireRequest(id);
  if (!r.category) throw new FlowError('Ainda não tenho o diagnóstico desse pedido', 409);
  if (!['diagnostico', 'sem_prestadores', 'escolhendo'].includes(r.status)) throw new FlowError(`Busca não disponível nessa etapa (${r.status})`, 409);
  bg(runSearch(id));
  return { ok: true };
});

app.post('/api/requests/:id/providers/:rpId', async (req) => {
  const { id, rpId } = rpParam.parse(req.params);
  const { selected } = z.object({ selected: z.boolean() }).parse(req.body);
  const r = requireRequest(id);
  const rp = requireRp(id, rpId);
  if (!['escolhendo', 'pagamento'].includes(r.status) || rp.status !== 'sugerido') throw new FlowError('A seleção não pode mais mudar', 409);
  updateRp(rpId, { selected: selected ? 1 : 0 });
  return { ok: true };
});

app.post('/api/requests/:id/dispatch', async (req) => {
  const { id } = idParam.parse(req.params);
  const res = await dispatch(id);
  return res.mode === 'payment' ? { ok: true, mode: res.mode, payment: paymentView(res.payment) } : res;
});

app.post('/api/requests/:id/cancel', async (req) => {
  const { id } = idParam.parse(req.params);
  cancelPending(id);
  cancelRequest(id);
  return { ok: true };
});

app.post('/api/requests/:id/quotes/:rpId/approve', async (req) => {
  const { id, rpId } = rpParam.parse(req.params);
  approve(id, rpId);
  return { ok: true };
});
app.post('/api/requests/:id/quotes/:rpId/reject', async (req) => {
  const { id, rpId } = rpParam.parse(req.params);
  reject(id, rpId);
  return { ok: true };
});
app.post('/api/requests/:id/quotes/:rpId/reply', async (req) => {
  const { id, rpId } = rpParam.parse(req.params);
  const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(req.body);
  requireRp(id, rpId);
  postMessage(id, 'user', text);
  pushUserReply(rpId, text);
  return { ok: true };
});

app.post('/api/requests/:id/providers/:rpId/resume', async (req) => {
  const { id, rpId } = rpParam.parse(req.params);
  requireRp(id, rpId);
  if (!resume(rpId)) throw new FlowError('Esse prestador não está pausado', 409);
  return { ok: true };
});

app.post('/api/requests/:id/rating', async (req) => {
  const { id } = idParam.parse(req.params);
  const b = z.object({
    providerId: z.coerce.number().int().positive(),
    stars: z.coerce.number().int().min(1).max(5),
    comment: z.string().max(2000).nullish(),
    serviceDone: z.boolean().optional(),
  }).parse(req.body);
  rate(id, b);
  return { ok: true };
});

// ---------- pagamentos ----------
app.get('/api/payments/:id', async (req) => {
  const { id } = idParam.parse(req.params);
  const p = getPayment(id);
  if (!p) throw new FlowError('Pagamento não encontrado', 404);
  return { ...paymentView(p), request_id: p.request_id };
});
app.post('/api/payments/:id/simulate', async (req) => {
  const { id } = idParam.parse(req.params);
  const p = simulatePayment(id);
  return { ...paymentView(p), request_id: p.request_id };
});

// ---------- WhatsApp ----------
const waView = () => ({ ...waState(), warning_seen: getSetting('wa_warning_seen') === '1' });
app.get('/api/whatsapp', async () => waView());
app.post('/api/whatsapp/connect', async () => {
  await connect();
  return waView();
});
app.post('/api/whatsapp/logout', async () => {
  await logout();
  return waView();
});

// ---------- settings ----------
// Corrige cidade/bairro digitados pro nome oficial (usado no onboarding antes do mapa)
app.post('/api/geo/normalize', async (req) => {
  const b = z.object({ city: z.string().trim().max(100), neighborhood: z.string().trim().max(100) }).parse(req.body ?? {});
  return normalizePlace(b.city, b.neighborhood);
});

app.get('/api/settings', async () => publicSettings());
app.put('/api/settings', async (req) => {
  const b = z.object({
    user_name: z.string().trim().max(100).optional(),
    user_email: z.union([z.literal(''), z.string().trim().email()]).optional(),
    user_city: z.string().trim().max(100).optional(),
    price_per_request: z.coerce.number().min(1).max(10000).optional(),
    wa_warning_seen: z.boolean().optional(),
    user_neighborhood: z.string().trim().max(100).optional(),
    onboarding_done: z.boolean().optional(),
  }).parse(req.body ?? {});
  if (b.user_neighborhood !== undefined) setSetting('user_neighborhood', b.user_neighborhood);
  if (b.onboarding_done !== undefined) setSetting('onboarding_done', b.onboarding_done ? '1' : '0');
  if (b.user_name !== undefined) setSetting('user_name', b.user_name);
  if (b.user_email !== undefined) setSetting('user_email', b.user_email);
  if (b.user_city !== undefined) setSetting('user_city', b.user_city);
  if (b.price_per_request !== undefined) setSetting('price_per_request', b.price_per_request.toFixed(2));
  if (b.wa_warning_seen !== undefined) setSetting('wa_warning_seen', b.wa_warning_seen ? '1' : '0');
  return publicSettings();
});

app.get('/api/health', async () => ({
  ok: true,
  claude: hasClaude(),
  places: hasPlaces(),
  mercadopago: hasMercadoPago(),
  transcription: !!process.env.OPENAI_API_KEY,
  devTestProvider: !!process.env.DEV_TEST_PROVIDER_PHONE,
  payments: paymentsEnabled(),
  whatsappOficial: channel.name,
}));

// ---------- WhatsApp oficial (V2): webhook da Twilio + rotas de dev ----------
await registerWhatsAppRoutes(app);

// ---------- SSE ----------
app.get('/api/stream', (req, reply: FastifyReply) => {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (ev: ServerEvent) => {
    const { type, ...data } = ev;
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  res.write('retry: 3000\n\n');
  send({ type: 'wa.status', ...waState() });
  bus.on('event', send);
  const hb = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.raw.on('close', () => {
    clearInterval(hb);
    bus.off('event', send);
  });
});

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

// ---------- subida ----------
setWhatsAppHandlers({
  inbound: onProviderMessage,
  manualReply: onManualReply,
  connected: resumeAfterConnect,
});
if (!hasClaude()) app.log.warn('ANTHROPIC_API_KEY não configurada: os agentes vão responder com erro no chat.');
sweepPayments();
recoverNegotiations();
startScheduler();
startChannel(app.log);
if (hasSavedSession()) void connect(); // reconecta só se já houver sessão salva

const port = Number(process.env.PORT) || 3333;
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void app.close().finally(() => process.exit(0));
  });
}
