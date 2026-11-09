// Envia os templates de server/src/channel/templates.ts pra aprovação da Meta via Twilio Content API.
//
//   npm run wa:templates                 # mostra o que seria enviado (não precisa de credencial)
//   npm run wa:templates -- create       # só cria os Contents no Twilio (serve pro sandbox; não vai pra Meta)
//   npm run wa:templates -- submit       # cria (se precisar) E manda pra revisão da Meta — só com o número oficial
//   npm run wa:templates -- submit pedido_novo boas_vindas
//   npm run wa:templates -- status       # situação da aprovação (lê os WA_TPL_* do .env)
//
// Depois do submit, copie as linhas WA_TPL_…=HX… pro .env (e pro Render).
import { contentSidFor, TEMPLATE_KEYS, TEMPLATES, renderTemplate, type TemplateDef, type TemplateKey } from '../src/channel/templates.ts';

const CONTENT = 'https://content.twilio.com/v1/Content';
const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
const auth = sid && token ? 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') : null;

function contentPayload(key: TemplateKey) {
  const t: TemplateDef = TEMPLATES[key];
  const variables = Object.fromEntries(t.samples.map((s, i) => [String(i + 1), s]));
  let types: Record<string, unknown>;
  if (t.category === 'authentication') {
    types = {
      'whatsapp/authentication': {
        add_security_recommendation: true,
        code_expiration_minutes: 10,
        actions: [{ type: 'COPY_CODE', copy_code_text: 'Copiar código' }],
      },
    };
  } else if (t.buttons?.length) {
    types = { 'twilio/quick-reply': { body: t.body, actions: t.buttons.map((b) => ({ id: b.id, title: b.title })) } };
  } else {
    types = { 'twilio/text': { body: t.body } };
  }
  return { friendly_name: `desenrola_${key}`, language: 'pt_BR', variables, types };
}

async function api(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { authorization: auth!, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.message ?? JSON.stringify(data).slice(0, 300)}`);
  return data;
}

const [cmd = 'list', ...args] = process.argv.slice(2);
const keys = (args.length ? args : TEMPLATE_KEYS) as TemplateKey[];
for (const k of keys) if (!(k in TEMPLATES)) throw new Error(`Template desconhecido: ${k}`);

if (cmd === 'list' || !auth) {
  if (cmd !== 'list') console.log('Sem TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN: só mostrando o que seria enviado.\n');
  for (const k of keys) {
    const t = TEMPLATES[k];
    const vars = Object.fromEntries(t.samples.map((s, i) => [String(i + 1), s]));
    console.log(`■ ${k}  [${t.category}]  ${contentSidFor(k) ? `SID ${contentSidFor(k)}` : '(sem SID)'}`);
    console.log(`  ${renderTemplate(k, vars)}`);
    if ('buttons' in t && t.buttons) console.log(`  botões: ${t.buttons.map((b) => b.title).join(' | ')}`);
    console.log();
  }
} else if (cmd === 'submit' || cmd === 'create') {
  const env: string[] = [];
  for (const k of keys) {
    const t = TEMPLATES[k];
    let sidCreated: string | null = contentSidFor(k);
    try {
      if (!sidCreated) {
        const c = await api(CONTENT, { method: 'POST', body: JSON.stringify(contentPayload(k)) });
        sidCreated = String(c.sid);
      }
      env.push(`WA_TPL_${k.toUpperCase()}=${sidCreated}`);
    } catch (e) {
      console.log(`✗ ${k}: não criou o conteúdo: ${(e as Error).message}`);
      continue;
    }
    if (cmd === 'create' || (t as TemplateDef).sessionOnly) {
      console.log(`✓ ${k}: ${sidCreated} criado (sem pedir aprovação)`);
      continue;
    }
    // revisão da Meta: só faz sentido com o número oficial (WhatsApp Business próprio), nunca no sandbox/trial
    try {
      await api(`${CONTENT}/${sidCreated}/ApprovalRequests/whatsapp`, {
        method: 'POST',
        body: JSON.stringify({ name: `desenrola_${k}`, category: t.category.toUpperCase() }),
      });
      console.log(`✓ ${k}: ${sidCreated} criado e enviado pra aprovação (${t.category})`);
    } catch (e) {
      console.log(`~ ${k}: ${sidCreated} criado; aprovação não enviada: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  if (env.length) console.log(`\nCole no .env (e no Render):\n${env.join('\n')}`);
} else if (cmd === 'status') {
  for (const k of keys) {
    const s = contentSidFor(k);
    if (!s) {
      console.log(`- ${k}: sem WA_TPL_${k.toUpperCase()}`);
      continue;
    }
    try {
      const a = await api(`${CONTENT}/${s}/ApprovalRequests`, { method: 'GET' });
      const w = a.whatsapp ?? {};
      console.log(`- ${k}: ${w.status ?? '?'}${w.category && w.category.toLowerCase() !== TEMPLATES[k].category ? ` ⚠ categoria virou ${w.category}` : ''}${w.rejection_reason ? ` · motivo: ${w.rejection_reason}` : ''}`);
    } catch (e) {
      console.log(`- ${k}: ${(e as Error).message}`);
    }
  }
} else {
  console.log('Uso: wa:templates [list|submit|status] [chaves…]');
}
