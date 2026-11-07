// Canal falso: sem credencial da Twilio, nada sai. Loga (telefone mascarado) e guarda em memória pros testes.
import { parseTwilioWebhook } from './twilio.ts';
import type { Button, Channel, Phone } from './types.ts';

export const maskPhone = (p: string) => (p.length <= 6 ? '***' : `${p.slice(0, 4)}***${p.slice(-4)}`);

export type StubSent = { id: string; to: Phone; kind: 'template' | 'text' | 'interactive'; payload: unknown };

export class StubChannel implements Channel {
  readonly name = 'stub' as const;
  readonly real = false;
  readonly sent: StubSent[] = [];
  private n = 0;

  private record(to: Phone, kind: StubSent['kind'], payload: unknown) {
    const id = `SMstub${Date.now()}${++this.n}`;
    this.sent.push({ id, to, kind, payload });
    if (process.env.NODE_ENV !== 'test') console.log(`[whatsapp:stub] ${kind} para +${maskPhone(to)} (${id})`);
    return Promise.resolve(id);
  }

  sendTemplate(to: Phone, contentSid: string, vars: Record<string, string>) {
    return this.record(to, 'template', { contentSid, vars });
  }
  sendText(to: Phone, text: string) {
    return this.record(to, 'text', { text });
  }
  sendInteractive(to: Phone, body: string, buttons: Button[]) {
    return this.record(to, 'interactive', { body, buttons });
  }
  /** Sem segredo pra conferir: recusa sempre. Em dev, simule entrada por /api/dev/whatsapp/inbound. */
  verifySignature() {
    return false;
  }
  parseWebhook(params: Record<string, string>) {
    return parseTwilioWebhook(params);
  }
}
