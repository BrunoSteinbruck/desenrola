import { useState } from 'react';
import { api, brl, ApiError, PROVIDER_STATUS_LABEL, type Card, type RequestDetail, type RequestProvider, type WaState } from '../api';
import { IconStar } from './ui';

type Ctx = {
  detail: RequestDetail;
  wa: WaState;
  isLatest: (kind: Card['kind']) => boolean;
  onError: (msg: string) => void;
};

const rating = (p: RequestProvider) =>
  p.rating_google != null
    ? `${p.rating_google.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${p.reviews_google ? ` · ${p.reviews_google} avaliações` : ''}`
    : 'Sem nota no Google';

function useAction(onError: (m: string) => void) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'wa_not_connected') return; // o servidor posta o cartão do QR
      if (e instanceof ApiError && e.code === 'email_required') return onError('Preciso do teu e-mail pro Pix. Coloca em Configurações.');
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
    case 'whatsapp':
      return <WhatsappCard ctx={ctx} />;
    case 'payment':
      return <PaymentCard ctx={ctx} />;
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
  const pending = ctx.detail.request.status === 'diagnostico' || ctx.detail.request.status === 'sem_prestadores';
  if (!pending) return null;
  return (
    <div className="actions">
      <button type="button" className="btn dark" disabled={busy} onClick={() => run(() => api.search(ctx.detail.request.id))}>
        {busy ? 'Procurando…' : `Procurar ${card.profissao.toLowerCase()}`}
      </button>
    </div>
  );
}

function ProvidersCard({ ctx }: { ctx: Ctx }) {
  const { busy, run } = useAction(ctx.onError);
  const { request, providers } = ctx.detail;
  const editable = request.status === 'escolhendo';
  const list = providers.filter((p) => p.status !== 'sem_whatsapp' || editable);
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
            Chamar no WhatsApp
          </button>
        </div>
      )}
    </div>
  );
}

export function WhatsappPanel({ wa, onError }: { wa: WaState; onError: (m: string) => void }) {
  const { busy, run } = useAction(onError);
  if (wa.status === 'conectado') {
    return <p className="msg-event">WhatsApp conectado{wa.me ? ` · ${wa.me}` : ''}</p>;
  }
  if (wa.status === 'qr' && wa.qr) {
    return (
      <div className="qr-wrap">
        <div className="qr">
          <img src={wa.qr} alt="QR code para conectar o WhatsApp" />
        </div>
        <div style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <ol className="steps">
            <li>Abre o WhatsApp no celular</li>
            <li>Toca em Aparelhos conectados</li>
            <li>Conectar um aparelho e aponta pra cá</li>
          </ol>
          <p className="warning">
            Conexão não oficial (aparelho vinculado). Eu só leio as conversas com os profissionais que tu escolher.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="actions" style={{ alignItems: 'center' }}>
      <button
        type="button"
        className="btn dark"
        disabled={busy || wa.status === 'conectando'}
        onClick={() => run(() => api.connectWhatsapp())}
      >
        {wa.status === 'conectando' ? 'Conectando…' : 'Mostrar QR code'}
      </button>
    </div>
  );
}

function WhatsappCard({ ctx }: { ctx: Ctx }) {
  if (ctx.wa.status === 'conectado' && !ctx.isLatest('whatsapp')) return null;
  return (
    <div className="card glass">
      <div className="card-body">
        <WhatsappPanel wa={ctx.wa} onError={ctx.onError} />
      </div>
    </div>
  );
}

function PaymentCard({ ctx }: { ctx: Ctx }) {
  const { busy, run } = useAction(ctx.onError);
  const [copied, setCopied] = useState(false);
  const p = ctx.detail.payment;
  if (!p) return null;
  if (p.status === 'approved' || p.status === 'pago') {
    return <p className="msg-event">Pix de {brl(p.amount_cents)} confirmado.</p>;
  }
  if (p.status === 'expired' || p.status === 'expirado' || p.status === 'cancelled') {
    return (
      <div className="card glass">
        <div className="card-body">
          <p className="quote-text">O Pix expirou.</p>
          <div className="actions">
            <button type="button" className="btn dark" disabled={busy} onClick={() => run(() => api.dispatch(ctx.detail.request.id))}>
              Gerar outro Pix
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="card glass">
      <div className="card-body">
        <div className="quote-top">
          <span className="who">Pix pra chamar os profissionais</span>
          <span className="price">{brl(p.amount_cents)}</span>
        </div>
        {p.provider === 'simulado' ? (
          <>
            <p className="quote-text">Modo de teste: nenhum dinheiro de verdade é cobrado.</p>
            <div className="actions">
              <button type="button" className="btn primary" disabled={busy} onClick={() => run(() => api.simulatePayment(p.id))}>
                Simular pagamento
              </button>
            </div>
          </>
        ) : (
          <div className="qr-wrap">
            {p.qr_base64 && (
              <div className="qr">
                <img src={`data:image/png;base64,${p.qr_base64}`} alt="QR code do Pix" />
              </div>
            )}
            <div style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p className="quote-text">Paga pelo app do banco. Eu sigo assim que confirmar.</p>
              {p.qr_code && (
                <>
                  <div className="copy">{p.qr_code}</div>
                  <div className="actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        void navigator.clipboard?.writeText(p.qr_code!);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }}
                    >
                      {copied ? 'Copiado' : 'Copiar código'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
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
        {done && <span className="tag ok">{p.status === 'fechado' ? 'Fechado' : 'Aprovado — confirmando com ele'}</span>}
        {p.status === 'recusou' && <span className="tag">Ele não vai poder atender</span>}
        {p.status === 'recusado_pelo_usuario' && <span className="tag">Recusado</span>}
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
