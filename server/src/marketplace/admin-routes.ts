// Rotas do /admin (V2): prestadores, convite (opt-in) e inbox humano.
// Protegidas pelo SITE_PASSWORD do site inteiro até existir login (F2).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get } from '../db.ts';
import { bus } from '../events.ts';
import { enqueue, OutboxError } from '../channel/index.ts';
import { getContact, windowOpen } from '../channel/store.ts';
import { outboxText, type OutboxRow } from '../channel/outbox.ts';
import { formatBR } from '../services/phone.ts';
import {
  adminProvidersView, getProviderV2, ProviderError, regionsOf, setProviderStatus, splitList, upsertProviderFromAdmin,
} from './providers.ts';
import { adminReply, closeHandoff, OfferError, type HandoffRow } from './offers.ts';
import { LEAD_STATUSES, recruitingView, setLeadStatus } from './leads.ts';

const providerBody = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(8).max(30),
  categories: z.union([z.string(), z.array(z.string())]),
  city: z.string().trim().min(1).max(100),
  neighborhoods: z.union([z.string(), z.array(z.string())]).default([]),
  bio: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(1000).nullish(),
});
const toList = (v: string | string[]) => (Array.isArray(v) ? v : splitList(v));

/** Manda o pedido de confirmação (boas_vindas). Só faz sentido pra quem ainda não confirmou. */
function invite(providerId: number) {
  const p = getProviderV2(providerId);
  if (!p?.phone_e164) throw new ProviderError('Prestador sem telefone', 404);
  const c = getContact(p.phone_e164);
  if (c?.opt_in_at && !c.opt_out_at) return { sent: false, reason: 'já confirmou' };
  const regions = regionsOf(p.id);
  const regiao = regions.length
    ? regions.some((r) => !r.neighborhood)
      ? regions[0].city
      : regions.map((r) => r.neighborhood).join(', ')
    : '-';
  try {
    enqueue({
      to: p.phone_e164,
      template: 'boas_vindas',
      vars: { nome: p.name.split(/\s+/)[0], categoria: splitList(p.categories).join(' e ') || 'serviços', regiao },
      ref: `invite:${p.id}`,
    });
  } catch (e) {
    if (e instanceof OutboxError && e.code === 'opt_out') {
      throw new ProviderError('Esse número pediu pra não receber mensagens. Só ele pode voltar, mandando VOLTAR.', 409);
    }
    throw e;
  }
  return { sent: true };
}

/** Conversa com um telefone: o que entrou (wa_inbound) e o que saiu (wa_outbox), em ordem. */
function thread(phone: string) {
  const ins = all<{ id: number; payload_json: string; received_at: string }>(
    "SELECT id, payload_json, received_at FROM wa_inbound WHERE from_phone = ? AND kind = 'message' ORDER BY id DESC LIMIT 200",
    phone,
  ).map((r) => {
    const m = JSON.parse(r.payload_json);
    return { dir: 'in' as const, at: r.received_at, text: m.buttonText ? `[${m.buttonText}]` : m.text || (m.media?.length ? '[mídia]' : '') };
  });
  const outs = all<OutboxRow & { created_at: string; sent_at: string | null }>(
    'SELECT * FROM wa_outbox WHERE to_phone = ? ORDER BY id DESC LIMIT 200',
    phone,
  ).map((r) => ({
    dir: 'out' as const,
    at: r.sent_at ?? r.created_at,
    text: outboxText(r),
    template: r.template_key,
    state: r.state,
    delivery: r.delivery_status,
    error: r.state === 'failed' || r.state === 'blocked' ? r.last_error : null,
    ref: r.ref,
  }));
  return [...ins, ...outs].sort((a, b) => a.at.localeCompare(b.at));
}

export async function registerAdminRoutes(app: FastifyInstance) {
  app.get('/api/admin/providers', async () => adminProvidersView());

  app.post('/api/admin/providers', async (req, reply) => {
    const b = providerBody.parse(req.body);
    const p = upsertProviderFromAdmin({ ...b, categories: toList(b.categories), neighborhoods: toList(b.neighborhoods) });
    const inv = invite(p.id);
    bus.publish({ type: 'admin.providers' });
    return reply.code(201).send({ id: p.id, invite: inv });
  });

  app.put('/api/admin/providers/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = providerBody.partial().extend({ status: z.enum(['ativo', 'pausado', 'bloqueado']).optional() }).parse(req.body ?? {});
    const cur = getProviderV2(id);
    if (!cur || cur.status === 'lead') throw new ProviderError('Prestador não encontrado', 404);
    upsertProviderFromAdmin({
      name: b.name ?? cur.name,
      phone: b.phone ?? cur.phone_e164!,
      categories: b.categories !== undefined ? toList(b.categories) : splitList(cur.categories),
      city: b.city ?? regionsOf(id)[0]?.city ?? '',
      neighborhoods: b.neighborhoods !== undefined ? toList(b.neighborhoods) : regionsOf(id).map((r) => r.neighborhood ?? '').filter(Boolean),
      bio: b.bio ?? cur.bio,
      notes: b.notes ?? cur.notes,
    });
    if (b.status) {
      // "ativo" só volta se ele já tiver confirmado; senão continua convidado
      const c = cur.phone_e164 ? getContact(cur.phone_e164) : undefined;
      setProviderStatus(id, b.status === 'ativo' && !(c?.opt_in_at && !c.opt_out_at) ? 'convidado' : b.status);
    }
    bus.publish({ type: 'admin.providers' });
    return { ok: true };
  });

  app.post('/api/admin/providers/:id/invite', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    return invite(id);
  });

  // ---------- recrutamento (F4) ----------
  app.get('/api/admin/recruiting', async (req) => {
    const q = z
      .object({ category: z.string().max(100).optional(), city: z.string().max(100).optional(), status: z.enum(LEAD_STATUSES).optional(), q: z.string().max(100).optional() })
      .parse(req.query ?? {});
    return recruitingView(q);
  });

  app.put('/api/admin/leads/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object({ lead_status: z.enum(LEAD_STATUSES), note: z.string().trim().max(500).nullish() }).parse(req.body);
    if (!setLeadStatus(id, b.lead_status, b.note)) throw new ProviderError('Contato não encontrado (ou já cadastrado)', 404);
    return { ok: true };
  });

  /** O contato topou: vira profissional cadastrado e recebe o pedido de confirmação (boas_vindas). */
  app.post('/api/admin/leads/:id/promote', async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const lead = getProviderV2(id);
    if (!lead || lead.status !== 'lead') throw new ProviderError('Contato não encontrado (ou já cadastrado)', 404);
    const b = providerBody.partial({ name: true, phone: true }).parse(req.body);
    const p = upsertProviderFromAdmin({
      name: b.name ?? lead.name,
      phone: b.phone ?? lead.phone_e164!,
      categories: toList(b.categories),
      city: b.city,
      neighborhoods: toList(b.neighborhoods),
      bio: b.bio ?? null,
      notes: b.notes ?? null,
    });
    const inv = invite(p.id);
    bus.publish({ type: 'admin.providers' });
    return reply.code(201).send({ id: p.id, invite: inv });
  });

  // ---------- inbox ----------
  app.get('/api/admin/inbox', async () => {
    const open = all<HandoffRow & { provider_name: string | null }>(
      `SELECT h.*, p.name AS provider_name FROM handoffs h LEFT JOIN providers p ON p.id = h.provider_id
        WHERE h.status = 'aberto' ORDER BY h.id DESC`,
    );
    const recent = all<{ phone: string; last_at: string }>(
      `SELECT phone, MAX(at) AS last_at FROM (
          SELECT from_phone AS phone, received_at AS at FROM wa_inbound WHERE kind = 'message'
          UNION ALL SELECT to_phone AS phone, created_at AS at FROM wa_outbox
        ) GROUP BY phone ORDER BY last_at DESC LIMIT 50`,
    );
    const nameOf = (phone: string) =>
      get<{ name: string }>("SELECT name FROM providers WHERE phone_e164 = ? AND status != 'lead' ORDER BY id DESC LIMIT 1", phone)?.name ??
      getContact(phone)?.profile_name ??
      null;
    return {
      handoffs: open.map((h) => ({ ...h, phone_display: formatBR(h.phone), window_open: windowOpen(h.phone) })),
      conversations: recent.map((r) => ({
        phone: r.phone,
        phone_display: formatBR(r.phone),
        name: nameOf(r.phone),
        last_at: r.last_at,
        window_open: windowOpen(r.phone),
        handoff_open: open.some((h) => h.phone === r.phone),
      })),
    };
  });

  app.get('/api/admin/conversations/:phone', async (req) => {
    const { phone } = z.object({ phone: z.string().regex(/^\d{12,13}$/) }).parse(req.params);
    const c = getContact(phone);
    return {
      phone,
      phone_display: formatBR(phone),
      window_open: windowOpen(phone),
      opt_in_at: c?.opt_in_at ?? null,
      opt_out_at: c?.opt_out_at ?? null,
      messages: thread(phone),
    };
  });

  app.post('/api/admin/conversations/:phone/reply', async (req, reply) => {
    const { phone } = z.object({ phone: z.string().regex(/^\d{12,13}$/) }).parse(req.params);
    const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(req.body);
    try {
      const id = adminReply(phone, text);
      bus.publish({ type: 'admin.inbox' });
      return { ok: true, id };
    } catch (e) {
      if (e instanceof OfferError) return reply.code(e.httpStatus).send({ error: e.message, code: e.code });
      throw e;
    }
  });

  app.post('/api/admin/handoffs/:id/close', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { resume } = z.object({ resume: z.boolean().default(true) }).parse(req.body ?? {});
    closeHandoff(id, resume);
    return { ok: true };
  });
}
