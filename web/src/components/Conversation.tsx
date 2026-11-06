import { useEffect, useMemo, useRef } from 'react';
import { api, STATUS_LABEL, type Card, type Message, type RequestDetail, type WaState } from '../api';
import { CardView } from './Cards';
import { Composer } from './ui';

export function Conversation({
  detail,
  streaming,
  wa,
  waiting,
  onError,
}: {
  detail: RequestDetail;
  streaming: Message | null;
  wa: WaState;
  waiting: boolean;
  onError: (m: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { request, messages } = detail;

  // Último índice de cada tipo de cartão: cartões "ao vivo" (progresso, WhatsApp) só aparecem uma vez.
  const lastIndexByKind = useMemo(() => {
    const m = new Map<Card['kind'], number | string>();
    for (const msg of messages) if (msg.card) m.set(msg.card.kind, msg.id);
    return m;
  }, [messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages.length, streaming?.content, detail.providers, detail.payment?.status]);

  const status = useMemo(() => {
    const active = detail.providers.filter((p) => p.selected && ['contatado', 'respondeu', 'orcou'].includes(p.status)).length;
    if (request.status === 'contatando' && active) return `Conversando com ${active} ${active === 1 ? 'profissional' : 'profissionais'}`;
    return STATUS_LABEL[request.status] ?? '';
  }, [detail.providers, request.status]);

  const send = async (text: string) => {
    try {
      await api.sendMessage(request.id, text);
    } catch {
      onError('Não consegui enviar a mensagem.');
    }
  };

  const closed = request.status === 'cancelado' || request.status === 'avaliado';

  return (
    <>
      <header className="convo-head">
        <h1>{request.title ?? 'Novo problema'}</h1>
        <span className="status">{status}</span>
      </header>
      <div className="scroll" ref={scrollRef}>
        <div className="thread">
          {messages.map((m) => (
            <MessageView
              key={m.id}
              m={m}
              ctx={{
                detail,
                wa,
                onError,
                isLatest: (kind) => lastIndexByKind.get(kind) === m.id,
              }}
            />
          ))}
          {streaming && (streaming.content ? <p className="msg-assistant">{streaming.content}</p> : <Typing />)}
          {!streaming && waiting && <Typing />}
        </div>
      </div>
      {!closed && (
        <div className="composer-wrap">
          <Composer id="reply" label="Mensagem" placeholder="Escreva aqui" onSend={send} />
        </div>
      )}
    </>
  );
}

function Typing() {
  return (
    <span className="typing" aria-label="Escrevendo">
      <i />
      <i />
      <i />
    </span>
  );
}

function MessageView({ m, ctx }: { m: Message; ctx: Parameters<typeof CardView>[0]['ctx'] }) {
  if (m.role === 'user') return <div className="msg-user">{m.content}</div>;
  if (m.card?.kind === 'error') return <p className="error-text">{m.content}</p>;
  return (
    <>
      {m.content &&
        (m.role === 'system_event' ? <p className="msg-event">{m.content}</p> : <p className="msg-assistant">{m.content}</p>)}
      {m.card && <CardView card={m.card} ctx={ctx} />}
    </>
  );
}
