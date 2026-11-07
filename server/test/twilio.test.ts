// Adaptador Twilio: assinatura do webhook, parser e a rota (sem rede).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'desenrola-test-'));
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'token-de-teste';
process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886';
process.env.WHATSAPP_WEBHOOK_URL = 'https://desenrola.example/webhooks/whatsapp';

const { twilioSignature, sameSignature, parseTwilioWebhook } = await import('../src/channel/twilio.ts');
const ch = await import('../src/channel/index.ts');
const { get } = await import('../src/db.ts');
const Fastify = (await import('fastify')).default;

test('assinatura = HMAC-SHA1 da URL + parâmetros em ordem alfabética', () => {
  const params = { From: 'whatsapp:+5551999990000', Body: 'oi', MessageSid: 'SM1' };
  const manual = createHmac('sha1', 'tk').update('https://x/y' + 'Body' + 'oi' + 'From' + 'whatsapp:+5551999990000' + 'MessageSid' + 'SM1').digest('base64');
  assert.equal(twilioSignature('tk', 'https://x/y', params), manual);
  assert.equal(sameSignature(manual, manual), true);
  assert.equal(sameSignature(manual.slice(1), manual), false);
  assert.equal(sameSignature(undefined, manual), false);
});

test('parser: mensagem com botão e mídia; status de entrega', () => {
  const [m] = parseTwilioWebhook({
    MessageSid: 'SM1', SmsStatus: 'received', From: 'whatsapp:+5551999990000', Body: 'Ver detalhes',
    ButtonPayload: 'ver', ButtonText: 'Ver detalhes', OriginalRepliedMessageSid: 'SM0', ProfileName: 'Marcos',
    NumMedia: '1', MediaUrl0: 'https://api.twilio.com/m/1', MediaContentType0: 'image/jpeg',
  });
  assert.deepEqual(m, {
    kind: 'message', providerMsgId: 'SM1', from: '5551999990000', profileName: 'Marcos', text: 'Ver detalhes',
    buttonId: 'ver', buttonText: 'Ver detalhes', repliedToMsgId: 'SM0', media: [{ url: 'https://api.twilio.com/m/1', contentType: 'image/jpeg' }],
  });
  assert.deepEqual(parseTwilioWebhook({ MessageSid: 'SM2', MessageStatus: 'delivered', SmsStatus: 'delivered' }), [
    { kind: 'status', providerMsgId: 'SM2', status: 'delivered', errorCode: null },
  ]);
  assert.deepEqual(parseTwilioWebhook({}), []);
});

test('rota do webhook: recusa sem assinatura, aceita a da Twilio e grava a entrada', async () => {
  const app = Fastify();
  await ch.registerWhatsAppRoutes(app);
  const params = { MessageSid: 'SMroute1', SmsStatus: 'received', From: 'whatsapp:+5551999990001', Body: 'olá' };
  const payload = new URLSearchParams(params).toString();
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };

  const bad = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload, headers });
  assert.equal(bad.statusCode, 403);
  const forged = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload, headers: { ...headers, 'x-twilio-signature': 'abc' } });
  assert.equal(forged.statusCode, 403);

  const sig = twilioSignature('token-de-teste', process.env.WHATSAPP_WEBHOOK_URL!, params);
  const ok = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload, headers: { ...headers, 'x-twilio-signature': sig } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body, '<Response/>');
  await ch.processInbound();
  const row = get<{ state: string; from_phone: string }>("SELECT state, from_phone FROM wa_inbound WHERE provider_msg_id = 'SMroute1'")!;
  assert.deepEqual({ ...row }, { state: 'done', from_phone: '5551999990001' });
  // rotas de dev não existem com o canal real
  const dev = await app.inject({ method: 'GET', url: '/api/dev/whatsapp/outbox' });
  assert.equal(dev.statusCode, 404);
  await app.close();
});
