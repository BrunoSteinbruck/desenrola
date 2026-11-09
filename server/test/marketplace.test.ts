// V2 ponta a ponta com o canal stub e o modelo trocado por um roteiro (sem gastar API, sem mandar nada):
// admin cadastra → boas_vindas → "Sim" → pedido → matching → pedido_novo → "Posso atender" → negociação →
// orçamento → aprovação (contatos) → os outros recebem pedido_encerrado. E: fila de um por vez, "Agora não",
// passagem pra humano, e lead nunca recebe nada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'desenrola-test-'));
process.env.NEGOCIADOR_DEBOUNCE_MS = '0';
for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM', 'WHATSAPP_WEBHOOK_URL', 'ANTHROPIC_API_KEY']) delete process.env[k];

const Fastify = (await import('fastify')).default;
const { all, get, run, now, getRp, getRequest } = await import('../src/db.ts');
const { loginClient, updateClient } = await import('../src/auth/clients.ts');
const { recordOptIn } = await import('../src/channel/store.ts');
const ch = await import('../src/channel/index.ts');
const { drainOutbox } = await import('../src/channel/outbox.ts');
const offers = await import('../src/marketplace/offers.ts');
const providers = await import('../src/marketplace/providers.ts');
const { registerAdminRoutes } = await import('../src/marketplace/admin-routes.ts');
const neg = await import('../src/agents/negociador.ts');
const relator = await import('../src/agents/relator.ts');
type LoopOptions = import('../src/agents/claude.ts').LoopOptions;

ch.onInboundMessage(offers.onInbound);
ch.onConsentChange((phone, kind) => {
  providers.onProviderConsent(phone, kind);
});

// ---------- roteiro no lugar do modelo ----------
const turns: string[] = [];
neg.setLoopForTests(async (o: LoopOptions) => {
  const last = o.history[o.history.length - 1];
  const input = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
  turns.push(input);
  let text = 'Pode me passar um valor aproximado e quando consegue atender?';
  const call = async (name: string, inp: unknown) =>
    o.handleTool({ type: 'tool_use', id: `t${turns.length}`, name, input: inp } as never);
  if (input.includes('Escreve agora a primeira mensagem')) {
    text = 'Pedido #X, eletricista na Cidade Baixa. O cliente contou que o chuveiro parou de esquentar. Consegue me passar um valor e quando poderia ir?';
  } else if (/fica (\d+)/.test(input)) {
    await call('registrar_orcamento', { valor_reais: Number(input.match(/fica (\d+)/)![1]), condicoes: 'com a peça', disponibilidade: 'amanhã 15h' });
    text = 'Obrigado! O cliente vai comparar e, se aprovar, te mando o contato dele por aqui.';
  } else if (input.includes('quero falar com uma pessoa')) {
    await call('escalar_para_humano', { motivo: 'pediu atendimento humano' });
    text = 'Claro, alguém da equipe do Desenrola te responde em breve.';
  }
  const history = [...o.history, { role: 'assistant' as const, content: text }];
  return { history, texts: [text], toolNames: [], last: {} as never };
});

// ---------- ajudantes ----------
const stub = ch.channel as unknown as { sent: { id: string; to: string; kind: string; payload: any }[] };
const tick = () => new Promise((r) => setTimeout(r, 5));
async function settle() {
  for (let i = 0; i < 8; i++) {
    run("UPDATE wa_outbox SET not_before = '2000-01-01T00:00:00.000Z' WHERE state = 'queued'");
    await drainOutbox(ch.channel);
    await ch.processInbound();
    await tick();
  }
}
const outbox = (phone: string) =>
  all<{ id: number; kind: string; template_key: string | null; payload_json: string; ref: string | null; state: string; provider_msg_id: string | null }>(
    'SELECT * FROM wa_outbox WHERE to_phone = ? ORDER BY id', phone,
  );
const lastTemplate = (phone: string, key: string) => [...outbox(phone)].reverse().find((r) => r.template_key === key);
let seq = 0;
async function say(from: string, text: string, extra: Partial<{ buttonId: string; buttonText: string; repliedToMsgId: string }> = {}) {
  ch.storeEvents([
    {
      kind: 'message', providerMsgId: `SMin${++seq}`, from, profileName: null, text,
      buttonId: extra.buttonId ?? null, buttonText: extra.buttonText ?? null, repliedToMsgId: extra.repliedToMsgId ?? null, media: [],
    },
  ]);
  await settle();
}
const tap = (from: string, key: 'pedido_novo' | 'boas_vindas', buttonId: string, buttonText: string, ref?: string) => {
  const row = [...outbox(from)].reverse().find((r) => r.template_key === key && (!ref || r.ref === ref))!;
  return say(from, buttonText, { buttonId, buttonText, repliedToMsgId: row.provider_msg_id! });
};
const CLIENTE = '5551988887777';
let clientId = 0;
function newRequest(text: string) {
  const ts = now();
  const id = Number(
    run(
      "INSERT INTO requests (status, client_id, title, summary, category, city, neighborhood, created_at, updated_at) VALUES ('diagnostico', ?, 'Chuveiro não esquenta', 'Chuveiro elétrico parou de esquentar; provavelmente a resistência.', 'eletricista', 'Porto Alegre', 'Cidade Baixa', ?, ?)",
      clientId, ts, ts,
    ).lastInsertRowid,
  );
  run("INSERT INTO messages (request_id, role, content, created_at) VALUES (?, 'user', ?, ?)", id, text, ts);
  return id;
}
const rpFor = (requestId: number, providerId: number) =>
  get<{ id: number; status: string }>('SELECT id, status FROM request_providers WHERE request_id = ? AND provider_id = ?', requestId, providerId)!;

const MARCOS = '5551990001111';
const JOAO = '5551990002222';
const LEAD = '5551990003333';
const app = Fastify();
await registerAdminRoutes(app);
let marcosId = 0;
let joaoId = 0;
let leadId = 0;

test('admin cadastra, boas_vindas sai e só o "Sim" ativa', async () => {
  // um lead da V1 (achado no Google) com a mesma profissão: nunca pode receber nada
  leadId = Number(run("INSERT INTO providers (name, phone_e164, source, status, categories) VALUES ('Lead Google', ?, 'google', 'lead', 'eletricista')", LEAD).lastInsertRowid);
  run("INSERT INTO provider_regions (provider_id, city_key, city) VALUES (?, 'porto alegre', 'Porto Alegre')", leadId);

  const r1 = await app.inject({
    method: 'POST', url: '/api/admin/providers',
    payload: { name: 'Marcos Eletricista', phone: '(51) 99000-1111', categories: 'eletricista', city: 'Porto Alegre', neighborhoods: 'Cidade Baixa, Bom Fim' },
  });
  assert.equal(r1.statusCode, 201, r1.body);
  marcosId = r1.json().id;
  const r2 = await app.inject({
    method: 'POST', url: '/api/admin/providers',
    payload: { name: 'João Instalações', phone: '51990002222', categories: ['eletricista', 'encanador'], city: 'Porto Alegre', neighborhoods: [] },
  });
  joaoId = r2.json().id;
  await settle();
  assert.match(JSON.parse(lastTemplate(MARCOS, 'boas_vindas')!.payload_json).vars['3'], /Cidade Baixa, Bom Fim/);
  assert.equal(providers.getProviderV2(marcosId)!.status, 'convidado');

  // ainda sem "Sim": nenhum match
  assert.equal(providers.eligibleProviders('eletricista', 'Porto Alegre', 'Cidade Baixa').length, 0);
  await tap(MARCOS, 'boas_vindas', 'optin_sim', 'Sim, quero receber');
  await tap(JOAO, 'boas_vindas', 'optin_sim', 'Sim, quero receber');
  assert.equal(providers.getProviderV2(marcosId)!.status, 'ativo');
  const list = (await app.inject('/api/admin/providers')).json();
  assert.ok(list.find((p: { id: number; opt_in_text: string }) => p.id === marcosId).opt_in_text.includes('Sim, quero receber'));
  assert.ok(!list.some((p: { id: number }) => p.id === leadId), 'lead não aparece no admin');
});

test('matching: categoria + região, bairro pesa, lead fica de fora', () => {
  const found = providers.eligibleProviders('Eletricista', 'porto alegre', 'Cidade Baixa');
  assert.deepEqual(found.map((p) => p.id), [marcosId, joaoId]); // Marcos atende o bairro; João, a cidade toda
  assert.equal(providers.eligibleProviders('encanador', 'Porto Alegre', 'Cidade Baixa').map((p) => p.id).join(), String(joaoId));
  assert.equal(providers.eligibleProviders('eletricista', 'Canoas', null).length, 0);
});

let req1 = 0;
test('pedido: matching → pedido_novo pros dois → Marcos vê e negocia → orçamento → aprovação troca os contatos', async () => {
  clientId = loginClient(CLIENTE).id;
  updateClient(clientId, { name: 'Bruno Steinbruck' });
  req1 = newRequest('meu chuveiro parou de esquentar, só sai água fria');
  assert.throws(() => offers.findProviders(999), /não encontrado/);
  assert.equal(offers.findProviders(req1).count, 2);
  assert.equal(offers.dispatch(req1).sent, 2);
  await settle();
  const offer = JSON.parse(lastTemplate(MARCOS, 'pedido_novo')!.payload_json).vars;
  assert.equal(offer['1'], String(req1));
  assert.equal(offer['3'], 'Cidade Baixa');
  assert.ok(!JSON.stringify(offer).includes('Bruno'), 'oferta sem dado pessoal');
  assert.equal(getRequest(req1)!.status, 'contatando');

  await tap(MARCOS, 'pedido_novo', 'posso_atender', 'Posso atender');
  assert.equal(rpFor(req1, marcosId).status, 'respondeu');
  assert.match(turns.at(-1)!, /Escreve agora a primeira mensagem/);
  assert.match(turns.at(-1)!, /só sai água fria/);
  const first = outbox(MARCOS).at(-1)!;
  assert.equal(first.kind, 'text');
  assert.equal(first.ref, `rp:${rpFor(req1, marcosId).id}`);

  await say(MARCOS, 'fica 80 com a peça, consigo amanhã 15h');
  const rp = getRp(rpFor(req1, marcosId).id)!;
  assert.equal(rp.status, 'orcou');
  assert.equal(rp.quote_value_cents, 8000);
  assert.ok(get("SELECT 1 FROM messages WHERE request_id = ? AND card_json LIKE '%\"quote\"%'", req1));

  relator.approve(req1, rp.id);
  await settle();
  const approved = JSON.parse(lastTemplate(MARCOS, 'orcamento_aprovado')!.payload_json).vars;
  assert.deepEqual([approved['2'].replace(/\s/g, ' '), approved['3'], approved['4']], ['R$ 80,00', 'Bruno', '(51) 98888-7777']);
  assert.equal(getRequest(req1)!.status, 'fechado');
  assert.equal(rpFor(req1, joaoId).status, 'dispensado');
  assert.match(JSON.parse(lastTemplate(JOAO, 'pedido_encerrado')!.payload_json).vars['3'], /escolheu outro/);
});

test('um pedido por vez: passar pro pedido novo deixa o anterior na fila, e ele volta quando o novo orça', async () => {
  const a = newRequest('tomada da sala faiscando');
  const b = newRequest('disjuntor caindo toda hora');
  for (const id of [a, b]) {
    offers.findProviders(id);
    run('UPDATE request_providers SET selected = 0 WHERE request_id = ? AND provider_id = ?', id, joaoId);
    offers.dispatch(id);
  }
  await settle();
  await tap(MARCOS, 'pedido_novo', 'posso_atender', 'Posso atender', `rp:${rpFor(a, marcosId).id}`);
  await tap(MARCOS, 'pedido_novo', 'posso_atender', 'Posso atender', `rp:${rpFor(b, marcosId).id}`);
  assert.equal(rpFor(a, marcosId).status, 'na_fila');
  assert.equal(rpFor(b, marcosId).status, 'respondeu');

  await say(MARCOS, 'essa fica 120'); // texto livre vai pro pedido da última mensagem (b)
  assert.equal(rpFor(b, marcosId).status, 'orcou');
  assert.equal(getRp(rpFor(b, marcosId).id)!.quote_value_cents, 12000);
  assert.equal(rpFor(a, marcosId).status, 'respondeu', 'a sai da fila sozinho');
  await new Promise((r) => setTimeout(r, 350)); // a retomada espera um pouco antes de falar
  await settle();
  assert.match(turns.at(-1)!, /voltou a este pedido/);

  // termina o a pra não sobrar negociação aberta nos próximos testes
  await say(MARCOS, 'fica 70');
  assert.equal(rpFor(a, marcosId).status, 'orcou');
});

test('oferta nova durante outra conversa: resposta sem citar fica guardada, pergunta qual pedido e vai pro escolhido', async () => {
  const old = newRequest('interruptor do quarto solto');
  offers.findProviders(old);
  run('UPDATE request_providers SET selected = 0 WHERE request_id = ? AND provider_id = ?', old, joaoId);
  offers.dispatch(old);
  await settle();
  await tap(MARCOS, 'pedido_novo', 'posso_atender', 'Posso atender', `rp:${rpFor(old, marcosId).id}`);
  assert.equal(rpFor(old, marcosId).status, 'respondeu');

  const fresh = newRequest('chuveiro elétrico sem sinal de vida');
  offers.findProviders(fresh);
  run('UPDATE request_providers SET selected = 0 WHERE request_id = ? AND provider_id = ?', fresh, joaoId);
  offers.dispatch(fresh);
  await settle();

  await say(MARCOS, 'posso sim, fica 80 trocando a resistência');
  assert.equal(getRp(rpFor(fresh, marcosId).id)!.quote_value_cents, null, 'nenhum valor sai antes de saber o pedido');
  assert.equal(getRp(rpFor(old, marcosId).id)!.quote_value_cents, null);
  const ask = lastTemplate(MARCOS, 'qual_pedido')!;
  const vars = JSON.parse(ask.payload_json).vars;
  assert.deepEqual([vars['1'], vars['3']], [String(fresh), String(old)]);
  assert.match(vars['2'], /chuveiro/);

  await say(MARCOS, `Pedido #${fresh}`, { buttonId: `pedido_${fresh}`, buttonText: `Pedido #${fresh}`, repliedToMsgId: ask.provider_msg_id! });
  assert.equal(getRp(rpFor(fresh, marcosId).id)!.quote_value_cents, 8000);
  assert.equal(getRp(rpFor(old, marcosId).id)!.quote_value_cents, null);
  assert.equal(rpFor(old, marcosId).status, 'respondeu', 'o antigo volta depois do orçamento');
  await new Promise((r) => setTimeout(r, 350));
  await settle();
  await say(MARCOS, 'fica 60');
  assert.equal(getRp(rpFor(old, marcosId).id)!.quote_value_cents, 6000);
});

test('qual pedido: dá pra responder só com o número, e o outro pedido segue intacto', async () => {
  const old = newRequest('tomada do quarto solta');
  const fresh = newRequest('lâmpada da sala queimando');
  offers.findProviders(old);
  run('UPDATE request_providers SET selected = 0 WHERE request_id = ? AND provider_id = ?', old, joaoId);
  offers.dispatch(old);
  await settle();
  await tap(MARCOS, 'pedido_novo', 'posso_atender', 'Posso atender', `rp:${rpFor(old, marcosId).id}`);
  offers.findProviders(fresh);
  run('UPDATE request_providers SET selected = 0 WHERE request_id = ? AND provider_id = ?', fresh, joaoId);
  offers.dispatch(fresh);
  await settle();

  await say(MARCOS, 'fica 110');
  await say(MARCOS, String(old));
  assert.equal(getRp(rpFor(old, marcosId).id)!.quote_value_cents, 11000);
  assert.equal(rpFor(fresh, marcosId).status, 'contatado');
  // acabou de orçar e tem oferta sem resposta: outro valor não pode sobrescrever o orçamento já enviado
  await say(MARCOS, 'fica 45');
  assert.equal(getRp(rpFor(old, marcosId).id)!.quote_value_cents, 11000);
  await say(MARCOS, String(fresh));
  assert.equal(getRp(rpFor(fresh, marcosId).id)!.quote_value_cents, 4500);
});

test('"Posso atender" manda ao agente o que o cliente contou e o que o diagnóstico perguntou', async () => {
  const q = newRequest('meu chuveiro parou');
  const ts = now();
  run("INSERT INTO messages (request_id, role, content, created_at) VALUES (?, 'assistant', 'O disjuntor desarmou?', ?)", q, ts);
  run("INSERT INTO messages (request_id, role, content, created_at) VALUES (?, 'user', 'não, está normal', ?)", q, ts);
  run("INSERT INTO messages (request_id, role, content, card_json, created_at) VALUES (?, 'assistant', 'Tu precisa de um eletricista.', '{\"kind\":\"diagnostico\"}', ?)", q, ts);
  offers.findProviders(q);
  run('UPDATE request_providers SET selected = 0 WHERE request_id = ? AND provider_id = ?', q, joaoId);
  offers.dispatch(q);
  await settle();
  await tap(MARCOS, 'pedido_novo', 'posso_atender', 'Posso atender', `rp:${rpFor(q, marcosId).id}`);
  const ctx = turns.at(-1)!;
  assert.match(ctx, /Escreve agora a primeira mensagem/);
  assert.match(ctx, /Desenrola perguntou: O disjuntor desarmou\?/);
  assert.match(ctx, /Cliente: não, está normal/);
  assert.doesNotMatch(ctx, /Tu precisa de um eletricista/);
  assert.doesNotMatch(ctx, /Desenrola perguntou: Tenho/);
  await say(MARCOS, 'fica 95');
  assert.equal(rpFor(q, marcosId).status, 'orcou');
});

test('o profissional também pode responder direto com o valor, sem tocar no botão, e vira orçamento', async () => {
  const e = newRequest('o disjuntor ta desarmando o tempo todo.');
  offers.findProviders(e);
  run('UPDATE request_providers SET selected = 0 WHERE request_id = ? AND provider_id = ?', e, marcosId);
  offers.dispatch(e);
  await settle();
  const offer = [...outbox(JOAO)].reverse().find((r) => r.template_key === 'pedido_novo' && r.ref === `rp:${rpFor(e, joaoId).id}`)!;
  assert.equal(JSON.parse(offer.payload_json).vars['4'], 'o disjuntor ta desarmando o tempo todo', 'relato do cliente, sem ponto final duplicado');
  await say(JOAO, 'fica 150 a visita com avaliação do quadro, amanhã de manhã', { repliedToMsgId: offer.provider_msg_id! });
  assert.equal(rpFor(e, joaoId).status, 'orcou');
  assert.doesNotMatch(turns.at(-1)!, /Escreve agora a primeira mensagem/);
  assert.match(turns.at(-1)!, /NÃO repete o pedido/);
});

test('orçamento vai inteiro pro WhatsApp do cliente e ele aprova ali mesmo', async () => {
  recordOptIn(CLIENTE, 'checkbox no site');
  const f = newRequest('tomada da cozinha faiscando');
  offers.findProviders(f);
  run('UPDATE request_providers SET selected = 0 WHERE request_id = ? AND provider_id = ?', f, marcosId);
  offers.dispatch(f);
  await settle();
  const offer = [...outbox(JOAO)].reverse().find((r) => r.ref === `rp:${rpFor(f, joaoId).id}`)!;
  await say(JOAO, 'fica 200 com a troca da tomada', { repliedToMsgId: offer.provider_msg_id! });
  const quote = lastTemplate(CLIENTE, 'cliente_orcamento_chegou')!;
  const v = JSON.parse(quote.payload_json).vars;
  assert.equal(v['2'], 'João Instalações');
  assert.match(v['3'], /200/);
  assert.match(v['4'], /com a peça/);
  assert.equal(quote.ref, `quote:${rpFor(f, joaoId).id}`);

  await say(CLIENTE, 'Aprovar', { buttonId: 'aprovar', buttonText: 'Aprovar', repliedToMsgId: quote.provider_msg_id! });
  assert.equal(getRequest(f)!.status, 'fechado');
  assert.equal(rpFor(f, joaoId).status, 'fechado');
  assert.ok(outbox(JOAO).some((r) => r.template_key === 'orcamento_aprovado' && r.ref === `rp:${rpFor(f, joaoId).id}`));
  assert.match(JSON.parse(outbox(CLIENTE).at(-1)!.payload_json).text, /Fechado! .*João Instalações/);
});

test('"Agora não" recusa, pausa o prestador e o pedido sem ninguém avisa o cliente', async () => {
  const c = newRequest('luz do banheiro piscando');
  offers.findProviders(c);
  run('UPDATE request_providers SET selected = 0 WHERE request_id = ? AND provider_id = ?', c, marcosId);
  offers.dispatch(c);
  await settle();
  await tap(JOAO, 'pedido_novo', 'agora_nao', 'Agora não');
  assert.equal(rpFor(c, joaoId).status, 'recusou');
  assert.ok(providers.getProviderV2(joaoId)!.paused_until! > now());
  assert.equal(getRequest(c)!.status, 'sem_prestadores');
  assert.ok(!providers.eligibleProviders('eletricista', 'Porto Alegre', 'Centro').some((p) => p.id === joaoId));
});

test('passagem pra humano: agente para, admin responde, devolve e o agente retoma sabendo o que foi dito', async () => {
  const d = newRequest('ventilador de teto fazendo barulho');
  offers.findProviders(d);
  offers.dispatch(d);
  await settle();
  await tap(MARCOS, 'pedido_novo', 'posso_atender', 'Posso atender', `rp:${rpFor(d, marcosId).id}`);
  assert.equal(rpFor(d, marcosId).status, 'respondeu');
  await say(MARCOS, 'quero falar com uma pessoa');
  const rp = rpFor(d, marcosId);
  assert.equal(rp.status, 'pausado');
  const inbox = (await app.inject('/api/admin/inbox')).json();
  const h = inbox.handoffs.find((x: { rp_id: number }) => x.rp_id === rp.id);
  assert.ok(h);
  assert.equal(h.window_open, true);

  const before = turns.length;
  await say(MARCOS, 'alô?');
  assert.equal(turns.length, before, 'agente não responde durante o atendimento humano');

  const r = await app.inject({ method: 'POST', url: `/api/admin/conversations/${MARCOS}/reply`, payload: { text: 'Oi Marcos, aqui é o Bruno da equipe. Pode seguir com o orçamento normalmente.' } });
  assert.equal(r.statusCode, 200, r.body);
  const conv = (await app.inject(`/api/admin/conversations/${MARCOS}`)).json();
  assert.ok(conv.messages.some((m: { dir: string; text: string }) => m.dir === 'in' && m.text === 'alô?'));

  await app.inject({ method: 'POST', url: `/api/admin/handoffs/${h.id}/close`, payload: { resume: true } });
  await settle();
  assert.equal(rpFor(d, marcosId).status, 'respondeu');
  assert.match(turns.at(-1)!, /equipe do Desenrola.*Pode seguir com o orçamento/);
});

test('número desconhecido vai pro inbox; resposta fora da janela é recusada', async () => {
  await say('5551977776666', 'oi, vi o anúncio, como faço pra entrar?');
  const inbox = (await app.inject('/api/admin/inbox')).json();
  assert.ok(inbox.handoffs.some((h: { phone: string; provider_id: number | null }) => h.phone === '5551977776666' && h.provider_id === null));
  run("UPDATE wa_contacts SET last_inbound_at = '2000-01-01T00:00:00.000Z' WHERE phone = '5551977776666'");
  const r = await app.inject({ method: 'POST', url: '/api/admin/conversations/5551977776666/reply', payload: { text: 'oi' } });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, 'janela_fechada');
});

test('opt-out pelo botão tira o prestador do matching; lead nunca recebeu nada', async () => {
  await tap(JOAO, 'pedido_novo', 'parar', 'Parar de receber');
  assert.equal(providers.getProviderV2(joaoId)!.status, 'saiu');
  run('UPDATE providers SET paused_until = NULL WHERE id = ?', joaoId);
  assert.ok(!providers.eligibleProviders('encanador', 'Porto Alegre', null).some((p) => p.id === joaoId));
  assert.equal(outbox(LEAD).length, 0);
  assert.equal(stub.sent.filter((s) => s.to === LEAD).length, 0);
  await app.close();
});
