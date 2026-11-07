// Canal WhatsApp oficial (V2): o número do Desenrola fala com prestadores e clientes.
// Uma interface só, com duas implementações: Twilio (real) e stub (dev/teste, só loga).
// Os agentes nunca falam com o fornecedor direto: passam pelo outbox (outbox.ts),
// que respeita opt-in, opt-out e a janela de 24h.

/** Telefone em E.164 sem "+": "5551991234567". */
export type Phone = string;

export type Button = { id: string; title: string };

/** O que o fornecedor sabe fazer. Chamado só pelo worker do outbox. */
export interface Channel {
  readonly name: 'twilio' | 'stub';
  /** true quando mensagens saem de verdade. */
  readonly real: boolean;
  /** Mensagem iniciada por nós: só template aprovado (contentSid). */
  sendTemplate(to: Phone, contentSid: string, vars: Record<string, string>): Promise<string>;
  /** Texto livre: só dentro da janela de 24h (o outbox confere antes). */
  sendText(to: Phone, text: string): Promise<string>;
  /** Texto com botões de resposta rápida, dentro da janela. */
  sendInteractive(to: Phone, body: string, buttons: Button[]): Promise<string>;
  /** Confere a assinatura do webhook. Falha fechada. */
  verifySignature(signature: string | undefined, params: Record<string, string>): boolean;
  /** Traduz o corpo do webhook em eventos. */
  parseWebhook(params: Record<string, string>): InboundEvent[];
}

export type InboundMessage = {
  kind: 'message';
  providerMsgId: string;
  from: Phone;
  profileName: string | null;
  text: string;
  /** id do botão tocado (quick reply), quando houver */
  buttonId: string | null;
  buttonText: string | null;
  /** quando é resposta (ou clique de botão) a uma mensagem nossa: o id dela. Liga o clique ao pedido. */
  repliedToMsgId: string | null;
  media: { url: string; contentType: string }[];
};

export type StatusUpdate = {
  kind: 'status';
  providerMsgId: string;
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'undelivered' | string;
  errorCode: string | null;
};

export type InboundEvent = InboundMessage | StatusUpdate;

export class ChannelError extends Error {
  constructor(
    message: string,
    /** false = não adianta tentar de novo (número inválido, template recusado…) */
    readonly retryable: boolean,
    readonly code?: string,
  ) {
    super(message);
  }
}
