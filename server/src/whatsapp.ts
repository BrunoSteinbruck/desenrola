// F4 — Conexão WhatsApp (Baileys 7): QR, sessão, outbox, recebimento, JID/LID, caps.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  Browsers, DisconnectReason, downloadMediaMessage, fetchLatestWaWebVersion, generateMessageIDV2,
  getContentType, isJidBroadcast, isJidGroup, isJidNewsletter, isLidUser, isPnUser, jidNormalizedUser,
  normalizeMessageContent, useMultiFileAuthState, proto,
  type WAMessage, type WASocket, type ConnectionState, type NewChatMessageCapInfo, type WACallEvent,
} from '@whiskeysockets/baileys';
import { bus, type WaStatus } from './events.ts';
import {
  all, CONTACTED, DATA_DIR, get, getRp, now, postMessage, run, updateRp, type RpRow, type ProviderRow,
} from './db.ts';
import { NOT_TRANSCRIBED, transcribe } from './services/transcribe.ts';

const AUTH_DIR = resolve(DATA_DIR, 'wa-auth');
const logger = pino({ level: process.env.WA_LOG_LEVEL ?? 'warn' });

let sock: WASocket | null = null;
let status: WaStatus = 'desconectado';
let qrDataUrl: string | null = null;
let me: string | null = null;
let myJids = new Set<string>();
let backoffMs = 5000;
let reconnectTimer: NodeJS.Timeout | null = null;
let connecting = false;
/** outbox pausada até (ms epoch) — cap de conversas novas / reachout time lock */
let outboxPausedUntil = 0;

// ---------- callbacks (setados pelo negociador, evita import circular) ----------
type InboundHandler = (rpId: number, text: string) => void;
let onInbound: InboundHandler = () => {};
let onManualReply: (rpId: number, text: string) => void = () => {};
let onConnected: () => void = () => {};
export function setWhatsAppHandlers(h: { inbound: InboundHandler; manualReply: (rpId: number, text: string) => void; connected: () => void }) {
  onInbound = h.inbound;
  onManualReply = h.manualReply;
  onConnected = h.connected;
}

// ---------- status ----------
export function waState() {
  return { status, qr: status === 'qr' ? qrDataUrl : null, me };
}
export const isConnected = () => status === 'conectado' && !!sock;

function setStatus(s: WaStatus) {
  status = s;
  if (s !== 'qr') qrDataUrl = null;
  bus.publish({ type: 'wa.status', ...waState() });
}

// ---------- JIDs ativos (shouldIgnoreJid) ----------
/** PNs (@s.whatsapp.net) de prestadores de pedidos ativos. Recarregado quando request_providers muda. */
let activePn = new Set<string>();
export function refreshActiveJids() {
  const rows = all<{ wa_jid: string | null }>(
    `SELECT p.wa_jid FROM request_providers rp
     JOIN providers p ON p.id = rp.provider_id JOIN requests r ON r.id = rp.request_id
     WHERE p.wa_jid IS NOT NULL AND rp.status IN (${CONTACTED.map(() => '?').join(',')})
       AND r.status NOT IN ('cancelado', 'avaliado')`,
    ...CONTACTED,
  );
  activePn = new Set(rows.map((r) => jidNormalizedUser(r.wa_jid!)));
}
bus.on('event', (ev) => {
  if (ev.type === 'provider.updated') refreshActiveJids();
});

function shouldIgnoreJid(jid: string): boolean {
  if (!jid) return false;
  if (isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) return true;
  const norm = jidNormalizedUser(jid);
  if (myJids.has(norm)) return false; // eco dos nossos aparelhos: precisamos pra detectar resposta manual
  // LID desconhecido nunca é ignorado aqui (a 1ª resposta pode vir como @lid antes de sabermos o wa_lid);
  // é checado no handler e descartado sem persistir se não for prestador.
  if (isLidUser(jid)) return false;
  if (isPnUser(jid)) return !activePn.has(norm);
  return false; // servidores/outros: deixa o Baileys tratar
}

function refreshMyJids() {
  const s = new Set<string>();
  const u = sock?.user;
  const creds = sock?.authState.creds.me;
  for (const j of [u?.id, u?.lid, u?.phoneNumber, creds?.id, creds?.lid]) if (j) s.add(jidNormalizedUser(j));
  myJids = s;
}

// ---------- conexão ----------
/** Sessão pareada salva? (creds.json com `me`; um QR nunca escaneado não conta) */
export function hasSavedSession(): boolean {
  const f = resolve(AUTH_DIR, 'creds.json');
  if (!existsSync(f)) return false;
  try {
    return !!JSON.parse(readFileSync(f, 'utf8'))?.me?.id;
  } catch {
    return false;
  }
}

export async function connect(): Promise<void> {
  if (sock || connecting) return;
  connecting = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  try {
    refreshActiveJids();
    setStatus('conectando');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version: [number, number, number] | undefined;
    try {
      const v = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(5000) });
      version = v.version as [number, number, number];
    } catch { /* usa o default do Baileys */ }

    const s = makeWASocket({
      auth: state,
      logger,
      ...(version ? { version } : {}),
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      shouldIgnoreJid,
      getMessage: async (key) => {
        if (!key.id) return undefined;
        const r = get<{ proto_json: string | null; body: string | null }>('SELECT proto_json, body FROM wa_messages WHERE wa_message_id = ?', key.id);
        if (!r) return undefined;
        if (r.proto_json) return proto.Message.fromObject(JSON.parse(r.proto_json));
        return r.body ? { conversation: r.body } : undefined;
      },
    });
    sock = s;
    s.ev.on('creds.update', saveCreds);
    s.ev.on('connection.update', (u) => void handleConnectionUpdate(s, u));
    s.ev.on('messages.upsert', ({ messages, type }) => {
      for (const m of messages) void handleUpsert(m, type).catch((err) => logger.error({ err }, 'upsert falhou'));
    });
    s.ev.on('lid-mapping.update', ({ pn, lid }) => {
      if (!pn || !lid) return;
      run('UPDATE providers SET wa_lid = ? WHERE wa_jid = ? AND (wa_lid IS NULL OR wa_lid != ?)', jidNormalizedUser(lid), jidNormalizedUser(pn), jidNormalizedUser(lid));
    });
    s.ev.on('message-capping.update', (info) => handleCapping(info));
    s.ev.on('call', (calls) => void handleCalls(calls));
  } catch (err) {
    logger.error({ err }, 'falha ao criar socket');
    sock = null;
    setStatus('desconectado');
  } finally {
    connecting = false;
  }
}

async function handleConnectionUpdate(s: WASocket, u: Partial<ConnectionState>) {
  if (s !== sock) return;
  if (u.qr) {
    qrDataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
    setStatus('qr');
    bus.publish({ type: 'wa.qr', qr: qrDataUrl });
  }
  if (u.reachoutTimeLock) handleTimeLock(u.reachoutTimeLock.isActive, u.reachoutTimeLock.timeEnforcementEnds);
  if (u.connection === 'connecting' && status !== 'qr') setStatus('conectando');
  if (u.connection === 'open') {
    backoffMs = 5000;
    refreshMyJids();
    me = s.user?.id ? jidNormalizedUser(s.user.id) : null;
    setStatus('conectado');
    try {
      const tl = await s.fetchAccountReachoutTimelock();
      if (tl?.isActive) handleTimeLock(true, tl.timeEnforcementEnds);
    } catch { /* opcional */ }
    onConnected();
    kickOutbox();
  }
  if (u.connection === 'close') {
    const code = (u.lastDisconnect?.error as any)?.output?.statusCode as number | undefined;
    const registered = !!s.authState.creds.me?.id; // pareado (creds.registered fica false no login por QR)
    sock = null;
    me = null;
    logger.warn({ code }, 'conexão fechada');
    if (code === DisconnectReason.loggedOut) {
      wipeAuth();
      setStatus('desconectado');
      notifyActiveRequests('O WhatsApp foi desconectado (sessão encerrada no celular). Conecta de novo pelo QR pra eu continuar.');
      return;
    }
    if (code === DisconnectReason.restartRequired) {
      void connect();
      return;
    }
    if (!registered) {
      // QR expirou sem ninguém escanear: para e espera o usuário pedir de novo
      wipeAuth();
      setStatus('desconectado');
      return;
    }
    if (code === DisconnectReason.connectionReplaced || code === DisconnectReason.badSession) {
      notifyActiveRequests('O WhatsApp caiu (sessão substituída ou corrompida). Vou tentar reconectar sozinho.');
    }
    setStatus('conectando');
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const wait = backoffMs;
  backoffMs = Math.min(backoffMs * 2, 120_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, wait);
}

function wipeAuth() {
  try { rmSync(AUTH_DIR, { recursive: true, force: true }); } catch { /* ok */ }
}

export async function logout() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const s = sock;
  sock = null;
  if (s) {
    try { await s.logout(); } catch { try { await s.end(undefined); } catch { /* ok */ } }
  }
  wipeAuth();
  me = null;
  setStatus('desconectado');
}

/** Requests com negociação em andamento recebem um aviso no chat. */
function notifyActiveRequests(text: string) {
  const reqs = all<{ id: number }>(
    "SELECT id FROM requests WHERE status IN ('pagamento','contatando','orcamentos','aguardando_confirmacao','fechado')",
  );
  for (const r of reqs) postMessage(r.id, 'system_event', text);
}

// ---------- caps ----------
function toMs(v: string | number | Date | undefined): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  if (!Number.isFinite(n)) return new Date(String(v)).getTime() || 0;
  return n < 1e12 ? n * 1000 : n;
}
function pauseOutbox(until: number, reason: string) {
  if (until <= outboxPausedUntil) return;
  outboxPausedUntil = until;
  const when = new Date(until).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const rqs = all<{ request_id: number }>(
    'SELECT DISTINCT rp.request_id FROM outbox o JOIN request_providers rp ON rp.id = o.request_provider_id WHERE o.sent_at IS NULL AND o.failed_at IS NULL',
  );
  for (const r of rqs) postMessage(r.request_id, 'system_event', `${reason} Os envios ficam na fila até ${when}.`);
}
function handleTimeLock(active: boolean | undefined, ends: Date | undefined) {
  if (!active) return;
  pauseOutbox(toMs(ends) || Date.now() + 3600_000, 'O WhatsApp bloqueou temporariamente mensagens novas na tua conta.');
}
function handleCapping(info: NewChatMessageCapInfo) {
  if (info.capping_status === 'CAPPED') {
    pauseOutbox(toMs(info.cycle_end_timestamp) || Date.now() + 24 * 3600_000, 'Bati na cota de conversas novas do WhatsApp.');
  }
}

// ---------- validação de número ----------
/** Devolve o JID do WhatsApp (pode diferir do E.164 pelo 9º dígito) ou null se não tem WhatsApp. */
export async function checkWhatsApp(e164: string): Promise<string | null | undefined> {
  if (!isConnected() || !sock) return undefined; // undefined = não deu pra checar
  try {
    const res = await sock.onWhatsApp(e164);
    const hit = res?.find((r) => r.exists);
    return hit ? jidNormalizedUser(hit.jid) : null;
  } catch (err) {
    logger.warn({ err }, 'onWhatsApp falhou');
    return undefined;
  }
}

// ---------- outbox ----------
export function enqueue(rpId: number, body: string, delayMs = 0) {
  const nb = new Date(Date.now() + delayMs).toISOString();
  run('INSERT INTO outbox (request_provider_id, body, not_before) VALUES (?, ?, ?)', rpId, body, nb);
  kickOutbox();
}
/** Próximo horário livre pra um *novo* prestador: 20–60s depois do último agendado. */
export function nextStaggerDelay(): number {
  const last = get<{ nb: string | null }>('SELECT MAX(not_before) AS nb FROM outbox WHERE sent_at IS NULL AND failed_at IS NULL');
  const base = last?.nb ? Math.max(Date.now(), new Date(last.nb).getTime()) : Date.now();
  const jitter = 20_000 + Math.random() * 40_000;
  return base - Date.now() + (last?.nb ? jitter : Math.random() * 5000);
}

let outboxBusy = false;
let outboxTimer: NodeJS.Timeout | null = null;
export function kickOutbox() {
  if (!outboxTimer) outboxTimer = setInterval(() => void drainOutbox(), 3000);
  void drainOutbox();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function drainOutbox() {
  if (outboxBusy || !isConnected() || !sock) return;
  if (Date.now() < outboxPausedUntil) return;
  outboxBusy = true;
  try {
    for (;;) {
      const item = get<{ id: number; request_provider_id: number; body: string; attempts: number }>(
        'SELECT * FROM outbox WHERE sent_at IS NULL AND failed_at IS NULL AND not_before <= ? ORDER BY not_before, id LIMIT 1',
        now(),
      );
      if (!item || !sock || !isConnected()) break;
      const rp = getRp(item.request_provider_id);
      const prov = rp && get<ProviderRow>('SELECT * FROM providers WHERE id = ?', rp.provider_id);
      if (!rp || !prov?.wa_jid || rp.status === 'pausado') {
        // pausado: segura a mensagem (não descarta) — empurra 1 min
        if (rp?.status === 'pausado') run('UPDATE outbox SET not_before = ? WHERE id = ?', new Date(Date.now() + 60_000).toISOString(), item.id);
        else run('UPDATE outbox SET failed_at = ?, error = ? WHERE id = ?', now(), 'sem jid', item.id);
        continue;
      }
      const jid = prov.wa_jid;
      const msgId = generateMessageIDV2(sock.user?.id);
      // grava o id ANTES de enviar: é o que separa "nós mandamos" de "o usuário digitou no celular"
      run('UPDATE outbox SET wa_message_id = ? WHERE id = ?', msgId, item.id);
      run(
        "INSERT OR IGNORE INTO wa_messages (request_provider_id, direction, wa_message_id, body, created_at) VALUES (?, 'out', ?, ?, ?)",
        rp.id, msgId, item.body, now(),
      );
      try {
        // "digitando..." proporcional ao tamanho (reenvia a cada ~8s, presença expira em ~10s)
        const typingMs = Math.min(2000 + item.body.length * 45, 15_000);
        for (let t = 0; t < typingMs; t += 8000) {
          await sock.sendPresenceUpdate('composing', jid);
          await sleep(Math.min(8000, typingMs - t));
        }
        await sock.sendPresenceUpdate('paused', jid);
        const sent = await sock.sendMessage(jid, { text: item.body }, { messageId: msgId });
        run('UPDATE outbox SET sent_at = ? WHERE id = ?', now(), item.id);
        if (sent?.message) run('UPDATE wa_messages SET proto_json = ? WHERE wa_message_id = ?', JSON.stringify(sent.message), msgId);
        const ts = now();
        updateRp(rp.id, {
          last_activity_at: ts,
          ...(rp.status === 'na_fila' ? { status: 'contatado' } : {}),
        });
      } catch (err) {
        logger.warn({ err }, 'envio falhou');
        run('DELETE FROM wa_messages WHERE wa_message_id = ?', msgId);
        const attempts = item.attempts + 1;
        if (attempts >= 3) run('UPDATE outbox SET failed_at = ?, error = ?, attempts = ? WHERE id = ?', now(), String(err).slice(0, 300), attempts, item.id);
        else run('UPDATE outbox SET attempts = ?, not_before = ?, wa_message_id = NULL WHERE id = ?', attempts, new Date(Date.now() + 60_000 * attempts).toISOString(), item.id);
        break;
      }
    }
  } finally {
    outboxBusy = false;
  }
}

// ---------- recebimento ----------
function findProviderByJid(jid: string | null | undefined): ProviderRow | undefined {
  if (!jid) return undefined;
  const n = jidNormalizedUser(jid);
  if (isLidUser(n)) return get<ProviderRow>('SELECT * FROM providers WHERE wa_lid = ? ORDER BY id DESC LIMIT 1', n);
  if (isPnUser(n)) return get<ProviderRow>('SELECT * FROM providers WHERE wa_jid = ? ORDER BY id DESC LIMIT 1', n);
  return undefined;
}

async function resolveProvider(jids: Array<string | null | undefined>): Promise<ProviderRow | undefined> {
  const list = jids.filter((j): j is string => !!j).map(jidNormalizedUser);
  let prov: ProviderRow | undefined;
  for (const j of list) if ((prov = findProviderByJid(j))) break;
  const lid = list.find((j) => isLidUser(j));
  let pn = list.find((j) => isPnUser(j));
  if (!prov && lid && !pn && sock) {
    try {
      pn = (await sock.signalRepository.lidMapping.getPNForLID(lid)) ?? undefined;
      if (pn) pn = jidNormalizedUser(pn);
      prov = findProviderByJid(pn);
    } catch { /* ok */ }
  }
  if (prov) {
    // backfill do que faltava
    if (lid && prov.wa_lid !== lid) run('UPDATE providers SET wa_lid = ? WHERE id = ?', lid, prov.id);
    if (pn && !prov.wa_jid) run('UPDATE providers SET wa_jid = ? WHERE id = ?', pn, prov.id);
  }
  return prov;
}

/** request_provider ativo mais recente do prestador. */
function activeRpFor(providerId: number): RpRow | undefined {
  return get<RpRow>(
    `SELECT rp.* FROM request_providers rp JOIN requests r ON r.id = rp.request_id
     WHERE rp.provider_id = ? AND rp.status IN (${CONTACTED.map(() => '?').join(',')})
       AND r.status NOT IN ('cancelado','avaliado')
     ORDER BY COALESCE(rp.last_activity_at, '') DESC, rp.id DESC LIMIT 1`,
    providerId, ...CONTACTED,
  );
}

async function extractText(m: WAMessage): Promise<{ text: string; media: string | null; transcript: string | null } | null> {
  const content = normalizeMessageContent(m.message);
  if (!content) return null;
  const type = getContentType(content);
  if (!type) return null;
  switch (type) {
    case 'conversation':
      return { text: content.conversation ?? '', media: null, transcript: null };
    case 'extendedTextMessage':
      return { text: content.extendedTextMessage?.text ?? '', media: null, transcript: null };
    case 'audioMessage': {
      let transcript: string | null = null;
      try {
        const buf = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock!.updateMediaMessage });
        transcript = await transcribe(buf, content.audioMessage?.mimetype ?? 'audio/ogg');
      } catch (err) {
        logger.warn({ err }, 'download de áudio falhou');
      }
      return { text: transcript ? `[áudio transcrito]: ${transcript}` : NOT_TRANSCRIBED, media: 'audio', transcript };
    }
    case 'imageMessage': {
      const cap = content.imageMessage?.caption;
      return { text: `[prestador enviou uma imagem]${cap ? ` legenda: ${cap}` : ''}`, media: 'image', transcript: null };
    }
    case 'videoMessage':
      return { text: '[prestador enviou um vídeo]', media: 'video', transcript: null };
    case 'documentMessage':
    case 'documentWithCaptionMessage':
      return { text: '[prestador enviou um documento]', media: 'document', transcript: null };
    case 'stickerMessage':
      return { text: '[prestador enviou uma figurinha]', media: 'sticker', transcript: null };
    case 'locationMessage':
      return { text: '[prestador enviou uma localização]', media: 'location', transcript: null };
    case 'contactMessage':
    case 'contactsArrayMessage':
      return { text: '[prestador enviou um contato]', media: 'contact', transcript: null };
    default:
      return null; // protocolMessage, reactionMessage, senderKeyDistribution etc.
  }
}

async function handleUpsert(m: WAMessage, type: 'notify' | 'append') {
  const key = m.key;
  if (!key?.id || !key.remoteJid || !m.message) return;
  if (isJidGroup(key.remoteJid) || isJidBroadcast(key.remoteJid) || isJidNewsletter(key.remoteJid)) return;
  if (key.fromMe) {
    // eco dos nossos próprios envios?
    if (get('SELECT 1 FROM wa_messages WHERE wa_message_id = ?', key.id) || get('SELECT 1 FROM outbox WHERE wa_message_id = ?', key.id)) return;
    if (type !== 'notify') return;
  } else if (type === 'append') {
    // só recuperação offline de prestador ativo (o resto é descartado abaixo)
  }
  const prov = await resolveProvider([key.remoteJid, key.remoteJidAlt]);
  if (!prov) return; // não é prestador: descarta sem persistir
  const rp = activeRpFor(prov.id);
  if (!rp) return;

  const content = normalizeMessageContent(m.message);
  const ctype = content ? getContentType(content) : undefined;
  if (!ctype || ctype === 'protocolMessage' || ctype === 'reactionMessage' || ctype === 'senderKeyDistributionMessage') return;

  if (key.fromMe) {
    // o usuário respondeu à mão pelo celular
    const body = content?.conversation ?? content?.extendedTextMessage?.text ?? '[mensagem que não é texto]';
    const ins = run(
      "INSERT OR IGNORE INTO wa_messages (request_provider_id, direction, wa_message_id, body, created_at) VALUES (?, 'out', ?, ?, ?)",
      rp.id, key.id, body, now(),
    );
    if (Number(ins.changes) > 0) onManualReply(rp.id, body);
    return;
  }

  // dedupe antes de baixar mídia
  const dup = get('SELECT 1 FROM wa_messages WHERE wa_message_id = ?', key.id);
  if (dup) return;
  const ex = await extractText(m);
  if (!ex || !ex.text.trim()) return;
  const ins = run(
    "INSERT OR IGNORE INTO wa_messages (request_provider_id, direction, wa_message_id, body, media_type, transcript, created_at) VALUES (?, 'in', ?, ?, ?, ?, ?)",
    rp.id, key.id, ex.text, ex.media, ex.transcript, now(),
  );
  if (Number(ins.changes) === 0) return;
  onInbound(rp.id, ex.text);
}

// ---------- ligações ----------
async function handleCalls(calls: WACallEvent[]) {
  for (const c of calls) {
    if (c.status !== 'offer' || c.isGroup) continue;
    const prov = await resolveProvider([c.from, c.callerPn, c.chatId]);
    if (!prov) continue;
    const rp = activeRpFor(prov.id);
    if (!rp) continue;
    postMessage(rp.request_id, 'system_event', `${prov.name} tentou ligar. Não atendo ligações; pedi pra mandar por mensagem.`);
    // uma vez por prestador (idempotente pela coluna carimbo)
    const r = run('UPDATE request_providers SET call_reply_sent_at = ? WHERE id = ? AND call_reply_sent_at IS NULL', now(), rp.id);
    if (Number(r.changes) > 0 && rp.status !== 'pausado') enqueue(rp.id, 'Agora não consigo atender, pode me mandar por aqui?', 3000);
  }
}
