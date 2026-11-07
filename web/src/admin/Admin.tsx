import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  adminApi,
  AdminApiError,
  subscribeAdmin,
  type AdminProvider,
  type ConversationThread,
  type Handoff,
  type Inbox,
  type ProviderStatus,
} from './adminApi';
import './admin.css';

type Tab = 'profissionais' | 'conversas';

const STATUS_LABEL: Record<ProviderStatus, string> = {
  convidado: 'Esperando o Sim',
  ativo: 'Ativo',
  pausado: 'Pausado',
  saiu: 'Saiu',
  bloqueado: 'Bloqueado',
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Deu algum problema. Tenta de novo.');

/** Aceita ISO ou "YYYY-MM-DD HH:MM:SS" (SQLite, UTC). */
function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
function fmtDate(s: string | null | undefined, withTime = true): string {
  const d = parseDate(s);
  if (!d) return '';
  return d.toLocaleString('pt-BR', withTime ? { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function fmtShort(s: string | null | undefined): string {
  const d = parseDate(s);
  if (!d) return '';
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}
function regionsText(p: AdminProvider): string {
  if (!p.regions.length) return '-';
  const byCity = new Map<string, string[] | null>();
  for (const r of p.regions) {
    const cur = byCity.get(r.city);
    if (!r.neighborhood || cur === null) byCity.set(r.city, null);
    else byCity.set(r.city, [...(cur ?? []), r.neighborhood]);
  }
  return [...byCity.entries()].map(([city, ns]) => (ns ? `${city}: ${ns.join(', ')}` : `${city} (cidade toda)`)).join(' · ');
}

const initialTab = (): Tab => (location.hash === '#conversas' ? 'conversas' : 'profissionais');

export function Admin() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [providers, setProviders] = useState<AdminProvider[] | null>(null);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [inboxTick, setInboxTick] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadProviders = useCallback(() => {
    adminApi.providers().then(setProviders, (e) => setLoadError(errMsg(e)));
  }, []);
  const loadInbox = useCallback(() => {
    adminApi.inbox().then(setInbox, (e) => setLoadError(errMsg(e)));
    setInboxTick((t) => t + 1);
  }, []);

  useEffect(() => {
    document.title = 'Desenrola · Admin';
    loadProviders();
    loadInbox();
    return subscribeAdmin({ inbox: loadInbox, providers: loadProviders });
  }, [loadProviders, loadInbox]);

  const switchTab = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', t === 'conversas' ? '#conversas' : location.pathname);
  };

  const openHandoffs = inbox?.handoffs.length ?? 0;

  return (
    <>
      <div className="backdrop" aria-hidden="true">
        <span className="b1" />
        <span className="b2" />
        <span className="b3" />
      </div>
      <div className="adm">
        <header className="adm-head glass">
          <div className="adm-brand">Desenrola · Admin</div>
          <nav className="adm-tabs" role="tablist" aria-label="Seções">
            <button
              role="tab"
              aria-selected={tab === 'profissionais'}
              className={`adm-tab${tab === 'profissionais' ? ' active' : ''}`}
              onClick={() => switchTab('profissionais')}
            >
              Profissionais
            </button>
            <button
              role="tab"
              aria-selected={tab === 'conversas'}
              className={`adm-tab${tab === 'conversas' ? ' active' : ''}`}
              onClick={() => switchTab('conversas')}
            >
              Conversas
              {openHandoffs > 0 && (
                <span className="adm-badge" aria-label={`${openHandoffs} atendimentos abertos`}>
                  {openHandoffs}
                </span>
              )}
            </button>
          </nav>
          <a className="adm-back" href="/">
            Voltar pro site
          </a>
        </header>

        {loadError && (
          <p className="error-text adm-load-error" role="alert">
            {loadError}{' '}
            <button className="btn ghost adm-small-btn" onClick={() => { setLoadError(null); loadProviders(); loadInbox(); }}>
              Tentar de novo
            </button>
          </p>
        )}

        {tab === 'profissionais' ? (
          <ProvidersTab providers={providers} reload={loadProviders} />
        ) : (
          <ConversationsTab inbox={inbox} tick={inboxTick} reload={loadInbox} />
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Profissionais                                                       */
/* ------------------------------------------------------------------ */

function ProvidersTab({ providers, reload }: { providers: AdminProvider[] | null; reload: () => void }) {
  const [editing, setEditing] = useState<AdminProvider | null>(null);
  const [filter, setFilter] = useState('');

  const shown = useMemo(() => {
    if (!providers) return null;
    const q = filter.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter((p) =>
      [p.name, p.phone_display, p.phone, p.categories.join(' '), regionsText(p), STATUS_LABEL[p.status] ?? p.status]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [providers, filter]);

  return (
    <div className="adm-providers">
      <AddProvider onAdded={reload} />

      <section className="glass adm-panel" aria-labelledby="adm-list-title">
        <div className="adm-panel-head">
          <h2 id="adm-list-title">
            Profissionais {providers && <span className="adm-count">{providers.length}</span>}
          </h2>
          <label className="sr-only" htmlFor="adm-filter">
            Filtrar profissionais
          </label>
          <input
            id="adm-filter"
            className="ob-input adm-filter"
            placeholder="Filtrar por nome, categoria, bairro"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {!shown ? (
          <p className="adm-empty">Carregando…</p>
        ) : shown.length === 0 ? (
          <p className="adm-empty">{providers?.length ? 'Ninguém com esse filtro.' : 'Nenhum profissional cadastrado ainda.'}</p>
        ) : (
          <ul className="adm-plist">
            {shown.map((p) => (
              <ProviderRow key={p.id} p={p} onEdit={() => setEditing(p)} reload={reload} />
            ))}
          </ul>
        )}
      </section>

      {editing && <EditProvider p={editing} onClose={() => setEditing(null)} onSaved={reload} />}
    </div>
  );
}

function AddProvider({ onAdded }: { onAdded: () => void }) {
  const empty = { name: '', phone: '', categories: '', city: 'Porto Alegre', neighborhoods: '', notes: '' };
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await adminApi.createProvider({
        name: f.name,
        phone: f.phone,
        categories: f.categories,
        city: f.city,
        neighborhoods: f.neighborhoods,
        notes: f.notes.trim() || null,
      });
      setDone(
        r.invite.sent
          ? `Pedido de confirmação enviado no WhatsApp pra ${f.name.trim().split(/\s+/)[0]}.`
          : `Salvo. Confirmação não enviada${r.invite.reason ? `: ${r.invite.reason}` : ''}.`,
      );
      setF(empty);
      onAdded();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass adm-panel" aria-labelledby="adm-add-title">
      <form className="adm-form" onSubmit={submit}>
        <h2 id="adm-add-title">Adicionar profissional</h2>
        <div className="adm-grid">
          <label className="field">
            Nome
            <input className="ob-input" required value={f.name} onChange={set('name')} autoComplete="off" />
          </label>
          <label className="field">
            Celular
            <input className="ob-input" required type="tel" inputMode="tel" placeholder="(51) 99999-9999" value={f.phone} onChange={set('phone')} autoComplete="off" />
          </label>
          <label className="field adm-span">
            Categorias
            <input className="ob-input" required placeholder="eletricista, encanador" value={f.categories} onChange={set('categories')} />
            <span className="adm-hint">Separa por vírgula.</span>
          </label>
          <label className="field">
            Cidade
            <input className="ob-input" required value={f.city} onChange={set('city')} />
          </label>
          <label className="field">
            Bairros
            <input className="ob-input" placeholder="Moinhos, Petrópolis" value={f.neighborhoods} onChange={set('neighborhoods')} />
            <span className="adm-hint">Vazio = cidade toda.</span>
          </label>
          <label className="field adm-span">
            Observações
            <textarea className="ob-input adm-textarea" rows={2} value={f.notes} onChange={set('notes')} />
          </label>
        </div>
        <div className="adm-form-foot">
          <button className="btn dark" type="submit" disabled={busy}>
            {busy ? 'Enviando…' : 'Adicionar e pedir confirmação'}
          </button>
          <div aria-live="polite">
            {done && <span className="tag ok">{done}</span>}
            {error && <span className="error-text">{error}</span>}
          </div>
        </div>
      </form>
    </section>
  );
}

function ProviderRow({ p, onEdit, reload }: { p: AdminProvider; onEdit: () => void; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const act = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ ok: true, text });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const resend = () =>
    act(async () => {
      const r = await adminApi.invite(p.id);
      return r.sent ? 'Confirmação reenviada.' : `Não reenviado${r.reason ? `: ${r.reason}` : ''}.`;
    });
  const setStatus = (status: 'ativo' | 'pausado' | 'bloqueado') =>
    act(async () => {
      await adminApi.updateProvider(p.id, { status });
      return null;
    });
  const block = () => {
    if (confirm(`Bloquear ${p.name}? Ele deixa de receber pedidos.`)) setStatus('bloqueado');
  };

  const canPause = p.status === 'ativo' || p.status === 'convidado';

  return (
    <li className="adm-prow">
      <div className="adm-prow-main">
        <div className="adm-prow-top">
          <span className="adm-pname">{p.name}</span>
          <span className={`adm-pill st-${p.status}`}>{STATUS_LABEL[p.status] ?? p.status}</span>
        </div>
        <div className="adm-pmeta">
          <span>{p.phone_display || p.phone || 'sem telefone'}</span>
          <span>{p.categories.join(', ') || 'sem categoria'}</span>
          <span>{regionsText(p)}</span>
          {p.our_rating_count > 0 && p.our_rating_avg != null && (
            <span>
              Nota {p.our_rating_avg.toFixed(1)} ({p.our_rating_count})
            </span>
          )}
        </div>
        <div className="adm-consent">
          {p.opt_out_at ? (
            <span>Pediu pra sair em {fmtDate(p.opt_out_at)}</span>
          ) : p.opt_in_at ? (
            <span title={p.opt_in_text ?? undefined}>
              Disse Sim em {fmtDate(p.opt_in_at)}
              {p.opt_in_text && <q className="adm-optin">{p.opt_in_text}</q>}
            </span>
          ) : (
            <span>Cadastrado em {fmtDate(p.created_at, false)}, sem confirmação ainda</span>
          )}
          {p.paused_until && p.status === 'pausado' && <span> · pausado até {fmtDate(p.paused_until)}</span>}
        </div>
        {p.notes && <div className="adm-notes">{p.notes}</div>}
        {msg && (
          <div className={msg.ok ? 'tag ok' : 'error-text adm-small'} role="status">
            {msg.text}
          </div>
        )}
      </div>
      <div className="adm-prow-actions">
        {p.status !== 'ativo' && p.status !== 'bloqueado' && (
          <button className="btn adm-small-btn" disabled={busy} onClick={resend}>
            Reenviar confirmação
          </button>
        )}
        {canPause ? (
          <button className="btn adm-small-btn" disabled={busy} onClick={() => setStatus('pausado')}>
            Pausar
          </button>
        ) : (
          <button className="btn adm-small-btn" disabled={busy} onClick={() => setStatus('ativo')}>
            Ativar
          </button>
        )}
        <button className="btn adm-small-btn" disabled={busy} onClick={onEdit}>
          Editar
        </button>
        {p.status !== 'bloqueado' && (
          <button className="btn ghost adm-small-btn adm-danger" disabled={busy} onClick={block}>
            Bloquear
          </button>
        )}
      </div>
    </li>
  );
}

function EditProvider({ p, onClose, onSaved }: { p: AdminProvider; onClose: () => void; onSaved: () => void }) {
  const city = p.regions[0]?.city ?? 'Porto Alegre';
  const [f, setF] = useState({
    name: p.name,
    categories: p.categories.join(', '),
    city,
    neighborhoods: p.regions.filter((r) => r.city === city && r.neighborhood).map((r) => r.neighborhood).join(', '),
    notes: p.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi.updateProvider(p.id, {
        name: f.name,
        categories: f.categories,
        city: f.city,
        neighborhoods: f.neighborhoods,
        notes: f.notes,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog glass adm-dialog" role="dialog" aria-modal="true" aria-labelledby="adm-edit-title" onSubmit={submit}>
        <h2 id="adm-edit-title">Editar {p.name}</h2>
        <label className="field">
          Nome
          <input ref={first} className="ob-input" required value={f.name} onChange={set('name')} />
        </label>
        <label className="field">
          Categorias
          <input className="ob-input" required value={f.categories} onChange={set('categories')} />
          <span className="adm-hint">Separa por vírgula.</span>
        </label>
        <div className="field-row">
          <label className="field">
            Cidade
            <input className="ob-input" required value={f.city} onChange={set('city')} />
          </label>
          <label className="field">
            Bairros
            <input className="ob-input" value={f.neighborhoods} onChange={set('neighborhoods')} />
            <span className="adm-hint">Vazio = cidade toda.</span>
          </label>
        </div>
        <label className="field">
          Observações
          <textarea className="ob-input adm-textarea" rows={2} value={f.notes} onChange={set('notes')} />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="actions adm-dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn dark" disabled={busy}>
            {busy ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Conversas                                                           */
/* ------------------------------------------------------------------ */

function WindowTag({ open }: { open: boolean }) {
  return <span className={`adm-win${open ? ' on' : ''}`}>{open ? 'janela aberta' : 'janela fechada'}</span>;
}

function ConversationsTab({ inbox, tick, reload }: { inbox: Inbox | null; tick: number; reload: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);

  const handoffFor = (phone: string): Handoff | undefined => inbox?.handoffs.find((h) => h.phone === phone);
  const others = inbox ? inbox.conversations.filter((c) => !inbox.handoffs.some((h) => h.phone === c.phone)) : [];

  return (
    <div className={`adm-inbox${selected ? ' has-sel' : ''}`}>
      <aside className="glass adm-panel adm-clist" aria-label="Conversas">
        {!inbox ? (
          <p className="adm-empty">Carregando…</p>
        ) : (
          <>
            <div className="adm-section-label">Precisam de gente ({inbox.handoffs.length})</div>
            {inbox.handoffs.length === 0 ? (
              <p className="adm-empty small">Nenhum atendimento aberto.</p>
            ) : (
              <ul className="adm-citems">
                {inbox.handoffs.map((h) => (
                  <li key={`h${h.id}`}>
                    <button
                      className={`adm-citem handoff${selected === h.phone ? ' active' : ''}`}
                      aria-current={selected === h.phone ? 'true' : undefined}
                      onClick={() => setSelected(h.phone)}
                    >
                      <span className="adm-citem-top">
                        <span className="adm-citem-name">{h.provider_name ?? h.phone_display}</span>
                        <span className="adm-citem-time">{fmtShort(h.created_at)}</span>
                      </span>
                      <span className="adm-citem-reason">{h.reason || 'sem motivo'}</span>
                      <span className="adm-citem-sub">
                        {h.provider_name && <span>{h.phone_display}</span>}
                        <WindowTag open={h.window_open} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="adm-section-label">Recentes</div>
            {others.length === 0 ? (
              <p className="adm-empty small">Nada por aqui.</p>
            ) : (
              <ul className="adm-citems">
                {others.map((c) => (
                  <li key={c.phone}>
                    <button
                      className={`adm-citem${selected === c.phone ? ' active' : ''}`}
                      aria-current={selected === c.phone ? 'true' : undefined}
                      onClick={() => setSelected(c.phone)}
                    >
                      <span className="adm-citem-top">
                        <span className="adm-citem-name">{c.name ?? c.phone_display}</span>
                        <span className="adm-citem-time">{fmtShort(c.last_at)}</span>
                      </span>
                      <span className="adm-citem-sub">
                        {c.name && <span>{c.phone_display}</span>}
                        <WindowTag open={c.window_open} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </aside>

      <section className="glass adm-panel adm-thread-panel" aria-label="Conversa selecionada">
        {selected ? (
          <ThreadView key={selected} phone={selected} handoff={handoffFor(selected)} tick={tick} onBack={() => setSelected(null)} reloadInbox={reload} />
        ) : (
          <p className="adm-empty center">Escolhe uma conversa à esquerda.</p>
        )}
      </section>
    </div>
  );
}

function ThreadView({
  phone,
  handoff,
  tick,
  onBack,
  reloadInbox,
}: {
  phone: string;
  handoff: Handoff | undefined;
  tick: number;
  onBack: () => void;
  reloadInbox: () => void;
}) {
  const [t, setT] = useState<ConversationThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    adminApi.conversation(phone).then(
      (r) => {
        setT(r);
        setError(null);
      },
      (e) => setError(errMsg(e)),
    );
  }, [phone]);

  useEffect(load, [load, tick]);

  const count = t?.messages.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  const windowOpen = t?.window_open ?? handoff?.window_open ?? false;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      await adminApi.reply(phone, body);
      setText('');
      load();
    } catch (err) {
      if (err instanceof AdminApiError && err.code === 'janela_fechada') load();
      setError(errMsg(err));
    } finally {
      setSending(false);
    }
  };

  const close = async (resume: boolean) => {
    if (!handoff) return;
    setClosing(true);
    setError(null);
    try {
      await adminApi.closeHandoff(handoff.id, resume);
      reloadInbox();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="adm-thread">
      <div className="adm-thread-head">
        <button className="btn ghost adm-small-btn adm-back-btn" onClick={onBack}>
          Voltar
        </button>
        <div className="adm-thread-title">
          <h2>{handoff?.provider_name ?? t?.phone_display ?? phone}</h2>
          <div className="adm-thread-sub">
            {handoff?.provider_name && <span>{t?.phone_display}</span>}
            <WindowTag open={windowOpen} />
            {t?.opt_out_at && <span className="adm-danger">pediu pra sair</span>}
          </div>
        </div>
      </div>

      {handoff && (
        <div className="adm-handoff-bar">
          <div>
            <div className="adm-handoff-label">Atendimento aberto</div>
            <div className="adm-handoff-reason">{handoff.reason || 'sem motivo'}</div>
          </div>
          <div className="actions">
            <button className="btn dark adm-small-btn" disabled={closing} onClick={() => close(true)}>
              Devolver pro agente
            </button>
            <button className="btn adm-small-btn" disabled={closing} onClick={() => close(false)}>
              Encerrar sem devolver
            </button>
          </div>
        </div>
      )}

      <div className="adm-msgs" ref={scrollRef}>
        {!t ? (
          <p className="adm-empty center">{error ? '' : 'Carregando…'}</p>
        ) : t.messages.length === 0 ? (
          <p className="adm-empty center">Sem mensagens.</p>
        ) : (
          t.messages.map((m, i) => (
            <div key={i} className={`adm-bubble ${m.dir}${m.error ? ' failed' : ''}`}>
              {m.dir === 'out' && m.template && <div className="adm-bubble-tpl">{m.template}</div>}
              <div className="adm-bubble-text">{m.text || <em>(sem texto)</em>}</div>
              {m.error && <div className="adm-bubble-err">{m.state === 'blocked' ? 'Bloqueada' : 'Falhou'}: {m.error}</div>}
              <div className="adm-bubble-meta">
                {fmtDate(m.at)}
                {m.dir === 'out' && (m.delivery || m.state) && <> · {m.delivery ?? m.state}</>}
              </div>
            </div>
          ))
        )}
      </div>

      {error && (
        <p className="error-text adm-thread-error" role="alert">
          {error}
        </p>
      )}

      <form className="adm-reply" onSubmit={send}>
        {t && !windowOpen && (
          <p className="adm-reply-closed">Janela de 24h fechada: só dá pra mandar template. Espera a pessoa escrever.</p>
        )}
        <div className="inline-input">
          <label className="sr-only" htmlFor="adm-reply-text">
            Resposta
          </label>
          <textarea
            id="adm-reply-text"
            rows={2}
            placeholder={windowOpen ? 'Escreve a resposta' : 'Indisponível com a janela fechada'}
            value={text}
            disabled={!windowOpen || sending}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button className="btn dark" type="submit" disabled={!windowOpen || sending || !text.trim()}>
            {sending ? 'Enviando…' : 'Enviar'}
          </button>
        </div>
      </form>
    </div>
  );
}
