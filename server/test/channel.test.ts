// Canal oficial com o stub: templates, outbox (opt-in, opt-out, janela de 24h, ordem, retry) e entrada durável.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'desenrola-test-'));
for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM', 'WHATSAPP_WEBHOOK_URL']) delete process.env[k];

const { run, get } = await import('../src/db.ts');
const ch = await import('../src/channel/index.ts');
const { drainOutbox, GAP_MS } = await import('../src/channel/outbox.ts');
const { getContact, recordOptIn, touchInbound } = await import('../src/channel/store.ts');
const { TEMPLATES, TEMPLATE_KEYS, buildVars, sanitizeVar, renderTemplate } = await import('../src/channel/templates.ts');
const { StubChannel } = await import('../src/channel/stub.ts');
const { ChannelError } = await import('../src/channel/types.ts');

const stub = ch.channel as InstanceType<typeof StubChannel>;
const P1 = '5551990000001';
const P2 = '5551990000002';
const due = () => run("UPDATE wa_outbox SET not_before = '2000-01-01T00:00:00.000Z' WHERE state = 'queued'");

test('canal sem credencial é o stub', () => {
  assert.equal(ch.channel.name, 'stub');
  assert.equal(ch.channel.verifySignature('x', {}), false);
});

test('templates seguem as regras da Meta', () => {
  for (const key of TEMPLATE_KEYS) {
    const t = TEMPLATES[key];
    const body = t.body.trim();
    if (t.category !== 'authentication') {
      assert.ok(!/^\{\{/.test(body), `${key} começa com variável`);
      assert.ok(!/\}\}[.!?"]?$/.test(body), `${key} termina com variável`);
    }
    const n = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    assert.deepEqual([...new Set(n)].sort((a, b) => a - b), t.vars.map((_, i) => i + 1), `${key}: variáveis fora de ordem`);
    assert.equal(t.samples.length, t.vars.length, `${key}: exemplos`);
    assert.ok(body.length <= 1024);
    for (const b of ('buttons' in t ? t.buttons : []) ?? []) assert.ok(b.title.length <= 20, `${key}: botão longo "${b.title}"`);
  }
});

test('variáveis são sanitizadas e obrigatórias', () => {
  assert.equal(sanitizeVar('  chuveiro\n\nnão   esquenta\t '), 'chuveiro não esquenta');
  assert.equal(sanitizeVar('   '), '-');
  assert.equal(sanitizeVar('x'.repeat(300)).length, 200);
  assert.throws(() => buildVars('pedido_novo', { pedido: '1' }), /falta a variável/);
  const v = buildVars('pedido_novo', { pedido: '12', categoria: 'eletricista', bairro: 'Cidade Baixa', relato: 'tomada\nsoltando faísca' });
  assert.ok(renderTemplate('pedido_novo', v).startsWith('Pedido #12: eletricista em Cidade Baixa\nRelato do cliente: "tomada soltando faísca"'));
});

test('template que exige opt-in não sai sem ele; o de confirmação sai', () => {
  const vars = { pedido: '1', categoria: 'eletricista', bairro: 'Centro', relato: 'x' };
  assert.throws(() => ch.enqueue({ to: P1, template: 'pedido_novo', vars }), (e: Error & { code?: string }) => e.code === 'sem_opt_in');
  const id = ch.enqueue({ to: P1, template: 'boas_vindas', vars: { nome: 'Marcos', categoria: 'eletricista', regiao: 'Centro' } });
  assert.ok(id > 0);
});

test('texto livre só dentro da janela de 24h', () => {
  assert.throws(() => ch.enqueue({ to: P2, text: 'oi' }), (e: Error & { code?: string }) => e.code === 'janela_fechada');
  touchInbound(P2, new Date(Date.now() - 25 * 3600_000).toISOString(), null);
  assert.throws(() => ch.enqueue({ to: P2, text: 'oi' }), (e: Error & { code?: string }) => e.code === 'janela_fechada');
  touchInbound(P2, new Date().toISOString(), 'Bruna');
  assert.ok(ch.enqueue({ to: P2, text: 'oi' }) > 0);
  assert.equal(getContact(P2)?.profile_name, 'Bruna');
});

test('a janela que fecha enquanto espera na fila derruba o envio', async () => {
  const P = '5551990000009';
  touchInbound(P, new Date().toISOString(), null);
  const id = ch.enqueue({ to: P, text: 'vai expirar' });
  run('UPDATE wa_contacts SET last_inbound_at = ? WHERE phone = ?', new Date(Date.now() - 25 * 3600_000).toISOString(), P);
  due();
  await drainOutbox(stub);
  const row = get<{ state: string; last_error: string }>('SELECT state, last_error FROM wa_outbox WHERE id = ?', id)!;
  assert.equal(row.state, 'failed');
  assert.match(row.last_error, /janela/);
});

test('fila manda na ordem, uma por vez por número, com intervalo', async () => {
  const P = '5551990000003';
  touchInbound(P, new Date().toISOString(), null);
  const a = ch.enqueue({ to: P, text: 'primeira' });
  const b = ch.enqueue({ to: P, text: 'segunda' });
  const nb = (id: number) => new Date(get<{ not_before: string }>('SELECT not_before FROM wa_outbox WHERE id = ?', id)!.not_before).getTime();
  assert.ok(nb(b) - nb(a) >= GAP_MS);
  due();
  stub.sent.length = 0;
  await drainOutbox(stub);
  assert.deepEqual(stub.sent.filter((s) => s.to === P).map((s) => (s.payload as { text: string }).text), ['primeira']);
  due();
  await drainOutbox(stub);
  assert.deepEqual(stub.sent.filter((s) => s.to === P).map((s) => (s.payload as { text: string }).text), ['primeira', 'segunda']);
  const row = get<{ state: string; provider_msg_id: string }>('SELECT state, provider_msg_id FROM wa_outbox WHERE id = ?', b)!;
  assert.equal(row.state, 'sent');
  assert.match(row.provider_msg_id, /^SMstub/);
});

test('erro temporário tenta de novo; erro definitivo falha e avisa', async () => {
  const P = '5551990000004';
  touchInbound(P, new Date().toISOString(), null);
  let calls = 0;
  const flaky = new StubChannel();
  flaky.sendText = async () => {
    calls++;
    if (calls === 1) throw new ChannelError('timeout', true);
    throw new ChannelError('número inválido', false, '21211');
  };
  const failures: string[] = [];
  ch.onSendFailure((f) => failures.push(f.error));
  const id = ch.enqueue({ to: P, text: 'oi' });
  due();
  await drainOutbox(flaky);
  let row = get<{ state: string; attempts: number }>('SELECT state, attempts FROM wa_outbox WHERE id = ?', id)!;
  assert.deepEqual([row.state, row.attempts], ['queued', 1]);
  due();
  await drainOutbox(flaky);
  row = get<{ state: string; attempts: number }>('SELECT state, attempts FROM wa_outbox WHERE id = ?', id)!;
  assert.deepEqual([row.state, row.attempts], ['failed', 2]);
  assert.deepEqual(failures, ['número inválido']);
});

const inbound = (from: string, text: string, extra: Record<string, string | null> = {}) => ({
  kind: 'message' as const,
  providerMsgId: `SMt${Math.random().toString(36).slice(2)}`,
  from,
  profileName: null,
  text,
  buttonId: null,
  buttonText: null,
  repliedToMsgId: null,
  media: [],
  ...extra,
});

test('botão "Sim, quero receber" grava o opt-in com a prova', async () => {
  const P = '5551990000005';
  ch.storeEvents([inbound(P, '', { buttonId: 'optin_sim', buttonText: 'Sim, quero receber' })]);
  await ch.processInbound();
  const c = getContact(P)!;
  assert.ok(c.opt_in_at);
  assert.match(c.opt_in_text!, /Sim, quero receber/);
  // agora pedido_novo pode sair
  assert.ok(ch.enqueue({ to: P, template: 'pedido_novo', vars: { pedido: '2', categoria: 'encanador', bairro: 'Bom Fim', relato: 'vazamento' } }) > 0);
});

test('"PARAR" vira opt-out, bloqueia a fila e "voltar" desfaz', async () => {
  const P = '5551990000006';
  recordOptIn(P, 'teste');
  touchInbound(P, new Date().toISOString(), null);
  const queued = ch.enqueue({ to: P, text: 'vai ser bloqueada' });
  ch.storeEvents([inbound(P, '  PARAR ')]);
  await ch.processInbound();
  assert.ok(getContact(P)!.opt_out_at);
  assert.equal(get<{ state: string }>('SELECT state FROM wa_outbox WHERE id = ?', queued)!.state, 'blocked');
  assert.throws(() => ch.enqueue({ to: P, text: 'oi' }), (e: Error & { code?: string }) => e.code === 'opt_out');
  assert.ok(stub.sent.some((s) => s.to === P && /não vamos mais/.test((s.payload as { text: string }).text)));
  ch.storeEvents([inbound(P, 'Voltar')]);
  await ch.processInbound();
  assert.equal(getContact(P)!.opt_out_at, null);
});

test('frase longa com "parar" não é opt-out', async () => {
  const P = '5551990000007';
  const got: string[] = [];
  ch.onInboundMessage((m) => {
    got.push(m.text);
  });
  ch.storeEvents([inbound(P, 'o disjuntor não para de cair quando ligo o chuveiro, dá pra parar isso?')]);
  await ch.processInbound();
  assert.equal(getContact(P)!.opt_out_at, null);
  assert.equal(got.length, 1);
});

test('evento duplicado (retry da Twilio) é processado uma vez só; clique traz a mensagem original', async () => {
  const P = '5551990000008';
  recordOptIn(P, 'teste');
  const outId = ch.enqueue({ to: P, template: 'pedido_novo', vars: { pedido: '3', categoria: 'eletricista', bairro: 'Centro', relato: 'tomada' }, ref: 'offer:3' });
  due();
  await drainOutbox(stub);
  const sid = get<{ provider_msg_id: string }>('SELECT provider_msg_id FROM wa_outbox WHERE id = ?', outId)!.provider_msg_id;

  const seen: { text: string; ref: string | null }[] = [];
  ch.onInboundMessage((m, ctx) => {
    seen.push({ text: m.buttonId ?? m.text, ref: ctx.repliedTo?.ref ?? null });
  });
  const ev = inbound(P, 'Ver detalhes', { buttonId: 'ver', buttonText: 'Ver detalhes', repliedToMsgId: sid });
  assert.equal(ch.storeEvents([ev]), 1);
  assert.equal(ch.storeEvents([ev]), 0);
  await ch.processInbound();
  assert.deepEqual(seen, [{ text: 'ver', ref: 'offer:3' }]);

  // status de entrega só avança, e repetido não duplica
  const st = (status: string) => ({ kind: 'status' as const, providerMsgId: sid, status, errorCode: null });
  ch.storeEvents([st('delivered'), st('read'), st('delivered'), st('sent')]);
  await ch.processInbound();
  assert.equal(get<{ delivery_status: string }>('SELECT delivery_status FROM wa_outbox WHERE id = ?', outId)!.delivery_status, 'read');
  assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM wa_inbound WHERE provider_msg_id = ? AND kind = 'status'", sid)!.n, 3);
});

test('9º dígito: aprende o formato do WhatsApp e, se o envio falhar por número desconhecido, tenta o outro', async () => {
  const P = '5551985907072';
  touchInbound(P, new Date().toISOString(), null);
  recordOptIn(P, 'teste');
  // sem saber o formato: manda com o 9; o Twilio avisa que o número não está no sandbox (63015)
  const id = ch.enqueue({ to: P, text: 'oi' });
  run("UPDATE wa_outbox SET not_before = '2000-01-01T00:00:00.000Z' WHERE state = 'queued'");
  await drainOutbox(stub);
  const first = stub.sent.at(-1)!;
  assert.equal(first.to, P);
  const sid = get<{ provider_msg_id: string }>('SELECT provider_msg_id FROM wa_outbox WHERE id = ?', id)!.provider_msg_id;
  ch.storeEvents([{ kind: 'status', providerMsgId: sid, status: 'failed', errorCode: '63015' }]);
  await ch.processInbound();
  assert.equal(getContact(P)!.wa_id, '555185907072');
  run("UPDATE wa_outbox SET not_before = '2000-01-01T00:00:00.000Z' WHERE state = 'queued'");
  await drainOutbox(stub);
  assert.equal(stub.sent.at(-1)!.to, '555185907072', 'reenviou sem o 9');
  // segunda falha não fica trocando de formato pra sempre
  const sid2 = stub.sent.at(-1)!.id;
  ch.storeEvents([{ kind: 'status', providerMsgId: sid2, status: 'failed', errorCode: '63015' }]);
  await ch.processInbound();
  assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM wa_outbox WHERE to_phone = ? AND state = 'queued'", P)!.n, 0);
});
