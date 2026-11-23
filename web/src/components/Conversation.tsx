import { useEffect, useMemo, useRef, useState } from 'react';
import { api, STATUS_LABEL, type Card, type Message, type RequestDetail, type Settings } from '../api';
import { CardView } from './Cards';
import { Composer } from './ui';

export function Conversation({
  detail,
  streaming,
  waiting,
  me,
  onLoggedIn,
  onError,
}: {
  detail: RequestDetail;
  streaming: Message | null;
  me: Settings;
  onLoggedIn: (me: Settings) => void;
  waiting: boolean;
  onError: (m: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { request, messages: all } = detail;
  const { shown, heldCard } = useStaggered(request.id, all);
  const messages = shown < all.length ? all.slice(0, shown) : all;
  const revealing = shown < all.length || heldCard != null;

  // Último índice de cada tipo de cartão: cartões "ao vivo" (progresso, WhatsApp) só aparecem uma vez.
  const lastIndexByKind = useMemo(() => {
    const m = new Map<Card['kind'], number | string>();
    for (const msg of messages) if (msg.card) m.set(msg.card.kind, msg.id);
    return m;
  }, [messages]);

  // orçamento revisado: só o aviso mais recente de cada profissional vira cartão; os anteriores ficam como texto
  const latestQuoteMsg = useMemo(() => {
    const m = new Map<number, number | string>();
    for (const msg of messages) if (msg.card?.kind === 'quote') m.set(msg.card.rpId, msg.id);
    return m;
  }, [messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages.length, streaming?.content, detail.providers, revealing]);

  // nos pedidos em andamento não mostra contador: os avisos e orçamentos já aparecem na conversa
  const status = request.status === 'contatando' || request.status === 'orcamentos' ? '' : (STATUS_LABEL[request.status] ?? '');

  const send = async (text: string) => {
    try {
      await api.sendMessage(request.id, text);
    } catch {
      onError('Não consegui enviar a mensagem.');
    }
  };

  const closed = request.status === 'cancelado' || request.status === 'avaliado';

  // O que o agente está fazendo agora (sem depender de evento: deriva do estado do pedido)
  const last = messages[messages.length - 1];
  const activity = revealing
    ? 'Pensando'
    : request.status === 'buscando'
      ? 'Procurando contatos na tua região'
      : waiting || (last?.role === 'user' && !closed)
        ? 'Pensando'
        : null;

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
              hideCard={m.id === heldCard}
              oldQuote={m.card?.kind === 'quote' && latestQuoteMsg.get(m.card.rpId) !== m.id}
              ctx={{
                detail,
                me,
                onLoggedIn,
                onError,
                isLatest: (kind) => lastIndexByKind.get(kind) === m.id,
              }}
            />
          ))}
          {streaming && (streaming.content ? <p className="msg-assistant">{streaming.content}</p> : <Typing label="Pensando" />)}
          {!streaming && activity && <Typing label={activity} />}
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

/** primeira mensagem nova depois de uma ação, e o intervalo entre as seguintes */
const FIRST_MS = 700;
const NEXT_MS = 1100;

/**
 * Quantas mensagens mostrar. Quando chegam várias de uma vez (ex.: depois de confirmar o bairro), aparecem
 * uma de cada vez, com o "Pensando" no meio. Ao abrir o pedido, mostra tudo; o que o usuário escreveu e o
 * texto que já veio digitando na tela (streamId) aparecem na hora.
 */
function useStaggered(requestId: number, messages: Message[]) {
  const [state, setState] = useState<{ requestId: number; shown: number; heldCard: Message['id'] | null }>({ requestId, shown: messages.length, heldCard: null });
  const same = state.requestId === requestId;
  if (!same) setState({ requestId, shown: messages.length, heldCard: null });
  const shown = same ? Math.min(state.shown, messages.length) : messages.length;
  const heldCard = same ? state.heldCard : null;
  // já revelou alguma desta leva: as próximas esperam o intervalo maior
  const midBatch = useRef(false);
  const total = messages.length;
  const next = messages[shown];
  const nextId = next?.id;
  const nextInstant = !!next && (next.role === 'user' || !!next.streamId);
  // texto com cartão (ex.: "Enquanto isso..." + a lista): o cartão vem um pouco depois do texto
  const nextSplit = !!next && !!next.content && !!next.card;
  useEffect(() => {
    if (heldCard != null) {
      const t = setTimeout(() => setState((s) => ({ ...s, heldCard: null })), NEXT_MS);
      return () => clearTimeout(t);
    }
    if (shown >= total) {
      midBatch.current = false;
      return;
    }
    if (nextInstant) return setState({ requestId, shown: shown + 1, heldCard: null });
    const t = setTimeout(() => {
      midBatch.current = true;
      setState({ requestId, shown: shown + 1, heldCard: nextSplit ? nextId! : null });
    }, midBatch.current ? NEXT_MS : FIRST_MS);
    return () => clearTimeout(t);
  }, [requestId, shown, total, nextId, nextInstant, nextSplit, heldCard]);
  return { shown, heldCard };
}

function Typing({ label }: { label: string }) {
  return (
    <div className="thinking" role="status" aria-live="polite">
      <span className="typing" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="thinking-label">{label}…</span>
    </div>
  );
}

function MessageView({ m, ctx, hideCard, oldQuote }: { m: Message; ctx: Parameters<typeof CardView>[0]['ctx']; hideCard?: boolean; oldQuote?: boolean }) {
  // o cartão do orçamento já diz quem mandou e quanto: o texto só aparece no lugar do cartão, nos orçamentos antigos
  const quoteCard = m.card?.kind === 'quote' && !oldQuote;
  if (m.role === 'user') return <div className="msg-user">{m.content}</div>;
  if (m.card?.kind === 'error') return <p className="error-text">{m.content}</p>;
  return (
    <>
      {m.content &&
        !quoteCard &&
        (m.role === 'system_event' ? <p className="msg-event">{m.content}</p> : <p className="msg-assistant">{m.content}</p>)}
      {m.card && !hideCard && !oldQuote && <CardView card={m.card} ctx={ctx} />}
    </>
  );
}
