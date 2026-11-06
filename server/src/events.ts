import { EventEmitter } from 'node:events';

export type WaStatus = 'desconectado' | 'qr' | 'conectando' | 'conectado';

export type ServerEvent =
  | { type: 'message.created'; requestId: number; message: unknown }
  | { type: 'message.delta'; requestId: number; messageId: string; text: string }
  | { type: 'message.done'; requestId: number; messageId: string }
  | { type: 'request.updated'; requestId: number }
  | { type: 'requests.changed' }
  | { type: 'provider.updated'; requestId: number; rpId: number }
  | { type: 'wa.status'; status: WaStatus; me: string | null; qr: string | null }
  | { type: 'wa.qr'; qr: string }
  | { type: 'payment.updated'; requestId: number; paymentId: number; status: string };

class Bus extends EventEmitter {
  publish(ev: ServerEvent) {
    this.emit('event', ev);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
