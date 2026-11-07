import { useState } from 'react';
import { api, brl, ApiError, PROVIDER_STATUS_LABEL, type Card, type RequestDetail, type RequestProvider } from '../api';
import { IconStar } from './ui';

type Ctx = {
  detail: RequestDetail;
  paymentsOn: boolean;
  isLatest: (kind: Card['kind']) => boolean;
  onError: (msg: string) => void;
};

const rating = (p: RequestProvider) =>
  p.our_rating_avg != null
    ? `${p.our_rating_avg.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} no Desenrola`
    : 'Novo no Desenrola';

function useAction(onError: (m: string) => void) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Não consegui fazer isso agora.');
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export function CardView({ card, ctx }: { card: Card; ctx: Ctx }) {
  switch (card.kind) {
    case 'diagnostico':
      return <DiagnosticoCard card={card} ctx={ctx} />;
    case 'providers':
      return <ProvidersCard ctx={ctx} />;
    case 'payment':
      return null; // Pix do cliente saiu na V2 (cobrança passa pro prestador, F6)
    case 'progress':
      return <ProgressCard ctx={ctx} />;
    case 'quote':
      return <QuoteCard rpId={card.rpId} ctx={ctx} />;
    case 'decision':
      return <DecisionCard rpId={card.rpId} pergunta={card.pergunta} ctx={ctx} />;
    case 'paused':
      return <PausedCard rpId={card.rpId} ctx={ctx} />;
    case 'rating':
      return <RatingCard providerId={card.providerId} providerName={card.providerName} ctx={ctx} />;
    default:
      return null;
  }
}

function DiagnosticoCard({ card, ctx }: { card: Extract<Card, { kind: 'diagnostico' }>; ctx: Ctx }) {
  const { busy, run } = useAction(ctx.onError);
  const pending = ctx.detail.request.status === 'diagnostico' || (ctx.detail.request.status === 'sem_prestadores' && ctx.isLatest('diagnostico'));
  if (!pending) return null;
  return (
    <div className="actions">
      <button type="button" className="btn dark" disabled={busy} onClick={() => run(() => api.search(ctx.detail.request.id))}>
        {busy ? 'Procurando…' : `Ver ${card.profissao.toLowerCase()} da região`}
      </button>
    </div>
  );
}

function ProvidersCard({ ctx }: { ctx: Ctx }) {
  const { busy, run } = useAction(ctx.onError);
  const { request, providers } = ctx.detail;
  const editable = request.status === 'escolhendo';
  if (!editable && !ctx.isLatest('providers')) return null;
  const list = providers.filter((p) => editable || p.status !== 'excluido');
  const selected = providers.filter((p) => p.selected).length;
  if (!list.length) return null;
  return (
    <div className="card glass">
      {list.map((p) => (
        <label key={p.id} className={`row${p.selected ? '' : ' off'}`}>
          <input
            type="checkbox"
            checked={p.selected}
            disabled={!editable}
            onChange={(e) => run(() => api.toggleProvider(request.id, p.id, e.target.checked))}
          />
          <span className="name">{p.name}</span>
          <span className="meta">{rating(p)}</span>
        </label>
      ))}
      {editable && (
        <div className="card-foot">
          <span className="note">{selected === 1 ? '1 selecionado' : `${selected} selecionados`}</span>
          <button
            type="button"
            className="btn dark"
            disabled={busy || selected === 0}
            onClick={() => run(() => api.dispatch(request.id))}
          >
            {selected === 1 ? 'Pedir orçamento' : 'Pedir orçamentos'}
          </button>
        </div>
      )}
    </div>
  );
}

function ProgressCard({ ctx }: { ctx: Ctx }) {
  if (!ctx.isLatest('progress')) return null;
  const list = ctx.detail.providers.filter((p) => p.selected);
  if (!list.length) return null;
  return (
    <div className="card glass">
      {list.map((p) => (
        <div key={p.id} className="row">
          <span className="name">{p.name}</span>
          <span className={`meta${p.status === 'orcou' || p.status === 'aprovado' || p.status === 'fechado' ? ' tag ok' : ''}`}>
            {PROVIDER_STATUS_LABEL[p.status] ?? p.status}
          </span>
        </div>
      ))}
    </div>
  );
}

function QuoteCard({ rpId, ctx }: { rpId: number; ctx: Ctx }) {
  const { busy, run } = useAction(ctx.onError);
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const p = ctx.detail.providers.find((x) => x.id === rpId);
  if (!p) return null;
  const reqId = ctx.detail.request.id;
  const open = p.status === 'orcou' || p.status === 'respondeu';
  const done = p.status === 'aprovado' || p.status === 'fechado';
  return (
    <div className="card glass">
      <div className="card-body">
        <div className="quote-top">
          <span className="who">
            {p.name}
            <small>{rating(p)}</small>
          </span>
          {p.quote_value_cents != null && <span className="price">{brl(p.quote_value_cents)}</span>}
        </div>
        {(p.quote_conditions || p.quote_availability) && (
          <p className="quote-text">{[p.quote_conditions, p.quote_availability].filter(Boolean).join(' · ')}</p>
        )}
        {done && <span className="tag ok">{p.status === 'fechado' ? 'Fechado · contatos trocados' : 'Aprovado'}</span>}
        {p.status === 'recusou' && <span className="tag">Ele não vai poder atender</span>}
        {p.status === 'recusado_pelo_usuario' && <span className="tag">Recusado</span>}
        {open && !replying && <p className="note">Ao aprovar, teu nome e celular vão pro profissional pra vocês combinarem o horário.</p>}
        {open && !replying && (
          <div className="actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => run(() => api.approve(reqId, rpId))}>
              Aprovar
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setReplying(true)}>
              Responder
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => run(() => api.reject(reqId, rpId))}>
              Recusar
            </button>
          </div>
        )}
        {replying && (
          <form
            className="inline-input"
            onSubmit={(e) => {
              e.preventDefault();
              const t = text.trim();
              if (!t) return;
              void run(async () => {
                await api.reply(reqId, rpId, t);
                setText('');
                setReplying(false);
              });
            }}
          >
            <label className="sr-only" htmlFor={`reply-${rpId}`}>
              Resposta para {p.name}
            </label>
            <input
              id={`reply-${rpId}`}
              autoFocus
              value={text}
              placeholder="Ex.: consegue fazer por 150?"
              onChange={(e) => setText(e.target.value)}
            />
            <button type="submit" className="btn dark" disabled={busy || !text.trim()}>
              Enviar
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function DecisionCard({ rpId, pergunta, ctx }: { rpId: number; pergunta: string; ctx: Ctx }) {
  const { busy, run } = useAction(ctx.onError);
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const p = ctx.detail.providers.find((x) => x.id === rpId);
  if (sent) return null;
  return (
    <div className="card glass">
      <div className="card-body">
        <span className="tag">{p?.name ?? 'Profissional'} perguntou</span>
        <p className="quote-text" style={{ color: 'var(--ink)' }}>
          {pergunta}
        </p>
        <form
          className="inline-input"
          onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t) return;
            void run(async () => {
              await api.reply(ctx.detail.request.id, rpId, t);
              setSent(true);
            });
          }}
        >
          <label className="sr-only" htmlFor={`decision-${rpId}`}>
            Tua resposta
          </label>
          <input id={`decision-${rpId}`} value={text} placeholder="Tua resposta" onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="btn dark" disabled={busy || !text.trim()}>
            Responder
          </button>
        </form>
      </div>
    </div>
  );
}

function PausedCard({ rpId, ctx }: { rpId: number; ctx: Ctx }) {
  const { busy, run } = useAction(ctx.onError);
  const p = ctx.detail.providers.find((x) => x.id === rpId);
  if (!p || p.status !== 'pausado') return null;
  // V2: quem assume é a equipe do Desenrola (admin); o cliente só vê o aviso
  return (
    <div className="actions">
      <button type="button" className="btn" disabled={busy} onClick={() => run(() => api.resume(ctx.detail.request.id, rpId))}>
        Retomar com {p.name}
      </button>
    </div>
  );
}

function RatingCard({ providerId, providerName, ctx }: { providerId: number; providerName: string; ctx: Ctx }) {
  const { busy, run } = useAction(ctx.onError);
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [done, setDone] = useState<boolean | null>(null);
  if (ctx.detail.request.status === 'avaliado') return <p className="msg-event">Avaliação registrada. Obrigado.</p>;
  return (
    <div className="card glass">
      <div className="card-body">
        <div className="actions">
          <button type="button" className={`btn${done === true ? ' dark' : ''}`} onClick={() => setDone(true)}>
            Foi feito
          </button>
          <button type="button" className={`btn${done === false ? ' dark' : ''}`} onClick={() => setDone(false)}>
            Não foi feito
          </button>
        </div>
        {done !== null && (
          <>
            <div className="stars" role="radiogroup" aria-label={`Nota para ${providerName}`}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={stars === n}
                  aria-label={`${n} ${n === 1 ? 'estrela' : 'estrelas'}`}
                  className={`star${n <= stars ? ' on' : ''}`}
                  onClick={() => setStars(n)}
                >
                  <IconStar />
                </button>
              ))}
            </div>
            <form
              className="inline-input"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() =>
                  api.rate(ctx.detail.request.id, { providerId, stars, comment: comment.trim(), serviceDone: done }),
                );
              }}
            >
              <label className="sr-only" htmlFor="rating-comment">
                Comentário
              </label>
              <input id="rating-comment" value={comment} placeholder="Comentário (opcional)" onChange={(e) => setComment(e.target.value)} />
              <button type="submit" className="btn dark" disabled={busy || stars === 0}>
                Enviar
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
