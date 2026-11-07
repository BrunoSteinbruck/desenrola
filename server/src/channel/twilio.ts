// Twilio WhatsApp via REST, sem SDK (mesmo desenho do Convivar: apps/api/src/whatsapp/).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { get, now, run } from '../db.ts';
import { ChannelError, type Button, type Channel, type InboundEvent, type Phone } from './types.ts';

const API = 'https://api.twilio.com/2010-04-01';
const CONTENT_API = 'https://content.twilio.com/v1/Content';

// Erros da Twilio em que repetir não adianta (número inválido, fora da janela, opt-out…).
const FATAL_CODES = new Set(['21211', '21408', '21610', '21614', '63003', '63016', '63024', '63032', '63049']);

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  /** remetente aprovado, ex.: "+5551999998888" (no sandbox: "+14155238886") */
  from: string;
  /** URL pública do webhook, igual à cadastrada na Twilio. Também vira StatusCallback. */
  webhookUrl: string;
};

export function twilioConfigFromEnv(): TwilioConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const webhookUrl = process.env.WHATSAPP_WEBHOOK_URL;
  if (!accountSid || !authToken || !from || !webhookUrl) return null;
  return { accountSid, authToken, from: from.replace(/^whatsapp:/, ''), webhookUrl };
}

/**
 * Assinatura da Twilio: HMAC-SHA1 (base64) da URL seguida dos parâmetros do corpo
 * em ordem alfabética de chave (chave+valor, sem separador).
 * A URL vem da config, nunca do request: atrás do proxy do Render host e protocolo não batem.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function sameSignature(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** "whatsapp:+5551991234567" -> "5551991234567" */
export const phoneFromAddress = (addr: string | undefined) => (addr ?? '').replace(/^whatsapp:/, '').replace(/\D/g, '');

export function parseTwilioWebhook(p: Record<string, string>): InboundEvent[] {
  const sid = p.MessageSid || p.SmsMessageSid || '';
  if (!sid) return [];
  const status = p.MessageStatus || p.SmsStatus;
  // inbound chega com SmsStatus=received; callbacks de status com MessageStatus=sent/delivered/…
  if (status && status !== 'received') {
    return [{ kind: 'status', providerMsgId: sid, status, errorCode: p.ErrorCode || null }];
  }
  const media: { url: string; contentType: string }[] = [];
  for (let i = 0; i < (Number(p.NumMedia) || 0); i++) {
    if (p[`MediaUrl${i}`]) media.push({ url: p[`MediaUrl${i}`], contentType: p[`MediaContentType${i}`] ?? '' });
  }
  return [
    {
      kind: 'message',
      providerMsgId: sid,
      from: phoneFromAddress(p.From),
      profileName: p.ProfileName || null,
      text: p.Body ?? '',
      buttonId: p.ButtonPayload || null,
      buttonText: p.ButtonText || null,
      repliedToMsgId: p.OriginalRepliedMessageSid || null,
      media,
    },
  ];
}

export class TwilioChannel implements Channel {
  readonly name = 'twilio' as const;
  readonly real = true;
  constructor(private readonly cfg: TwilioConfig) {}

  private auth() {
    return 'Basic ' + Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64');
  }

  private async post(url: string, body: URLSearchParams | object): Promise<Record<string, unknown>> {
    const json = !(body instanceof URLSearchParams);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: this.auth(),
          'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded',
        },
        body: json ? JSON.stringify(body) : body.toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new ChannelError(`Twilio inacessível: ${(e as Error).message}`, true);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = data.code != null ? String(data.code) : undefined;
      const retryable = res.status === 429 || res.status >= 500 ? !FATAL_CODES.has(code ?? '') : false;
      throw new ChannelError(`Twilio HTTP ${res.status}${code ? ` (${code})` : ''}: ${String(data.message ?? '').slice(0, 200)}`, retryable, code);
    }
    return data;
  }

  private async message(to: Phone, fields: Record<string, string>): Promise<string> {
    const body = new URLSearchParams({
      To: `whatsapp:+${to}`,
      From: `whatsapp:${this.cfg.from}`,
      StatusCallback: this.cfg.webhookUrl,
      ...fields,
    });
    const data = await this.post(`${API}/Accounts/${this.cfg.accountSid}/Messages.json`, body);
    return String(data.sid);
  }

  sendTemplate(to: Phone, contentSid: string, vars: Record<string, string>) {
    return this.message(to, { ContentSid: contentSid, ContentVariables: JSON.stringify(vars) });
  }

  sendText(to: Phone, text: string) {
    return this.message(to, { Body: text });
  }

  /** Botões dentro da janela: a Twilio exige um Content (quick-reply), que dentro da sessão não precisa de aprovação. */
  async sendInteractive(to: Phone, body: string, buttons: Button[]) {
    const sid = await this.quickReplyContent(body, buttons);
    return this.message(to, { ContentSid: sid });
  }

  private async quickReplyContent(body: string, buttons: Button[]): Promise<string> {
    const hash = createHash('sha256').update(JSON.stringify({ body, buttons })).digest('hex').slice(0, 32);
    const cached = get<{ content_sid: string }>('SELECT content_sid FROM wa_content_cache WHERE hash = ?', hash);
    if (cached) return cached.content_sid;
    const data = await this.post(CONTENT_API, {
      friendly_name: `qr_${hash.slice(0, 16)}`,
      language: 'pt_BR',
      types: {
        'twilio/quick-reply': { body, actions: buttons.map((b) => ({ id: b.id, title: b.title.slice(0, 20) })) },
        'twilio/text': { body },
      },
    });
    const sid = String(data.sid);
    run('INSERT OR IGNORE INTO wa_content_cache (hash, content_sid, created_at) VALUES (?, ?, ?)', hash, sid, now());
    return sid;
  }

  verifySignature(signature: string | undefined, params: Record<string, string>) {
    return sameSignature(signature, twilioSignature(this.cfg.authToken, this.cfg.webhookUrl, params));
  }

  parseWebhook(params: Record<string, string>) {
    return parseTwilioWebhook(params);
  }
}
