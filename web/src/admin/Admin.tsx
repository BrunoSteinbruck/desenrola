import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { BrandMark } from '../App';
import { IconBack, IconSearch, IconSend } from '../components/ui';
import { phoneOk } from '../components/fields';
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
import { ActionsMenu, ConfirmDialog, draftOk, Drawer, errMsg, ProviderFields, type MenuItem, type ProviderDraft } from './parts';
import './admin.css';
import { RecruitingTab } from './Recruiting';

type Tab = 'profissionais' | 'conversas' | 'recrutamento';

const STATUS_LABEL: Record<ProviderStatus, string> = {
  convidado: 'Esperando confirmação',
  ativo: 'Ativo',
  pausado: 'Pausado',
  saiu: 'Saiu',
  bloqueado: 'Bloqueado',
};

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
  return [...byCity.entries()].map(([city, ns]) => (ns ? `${city}: ${ns.join(', ')}` : `${city}, cidade toda`)).join(' · ');
}

const initialTab = (): Tab => (location.hash === '#conversas' ? 'conversas' : location.hash === '#recrutamento' ? 'recrutamento' : 'profissionais');

export function Admin() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [providers, setProviders] = useState<AdminProvider[] | null>(null);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [inboxTick, setInboxTick] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const notify = useCallback((msg: string) => {
    clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  const loadProviders = useCallback(() => {
    adminApi.providers().then(
      (r) => {
        setProviders(r);
        setLoadError(null);
      },
      (e) => setLoadError(errMsg(e)),
    );
  }, []);
  const loadInbox = useCallback(() => {
    adminApi.inbox().then(
      (r) => {
        setInbox(r);
        setLoadError(null);
      },
      (e) => setLoadError(errMsg(e)),
    );
    setInboxTick((t) => t + 1);
  }, []);

  useEffect(() => {
    document.title = 'Desenrola · Admin';
    loadProviders();
    loadInbox();
    return subscribeAdmin({ inbox: loadInbox, providers: loadProviders });
  }, [loadProviders, loadInbox]);

  // fora do ar (deploy): tenta de novo sozinho, sem ninguém precisar clicar
  useEffect(() => {
    if (!loadError) return;
    const t = setInterval(() => {
      loadProviders();
      loadInbox();
    }, 5000);
    return () => clearInterval(t);
  }, [loadError, loadProviders, loadInbox]);

  const switchTab = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', t === 'profissionais' ? location.pathname : `#${t}`);
  };

  const openHandoffs = inbox?.handoffs.length ?? 0;
  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'profissionais', label: 'Profissionais' },
    { id: 'conversas', label: 'Conversas', badge: openHandoffs },
    { id: 'recrutamento', label: 'Recrutamento' },
  ];

  return (
    <div className="adm">
      <header className="adm-bar">
        <a className="adm-brand" href="/" aria-label="Voltar pro site">
          <BrandMark size={26} />
          desenrola
        </a>
        <nav className="adm-tabs" aria-label="Seções">
          {tabs.map((t) => (
            <button key={t.id} type="button" aria-current={tab === t.id ? 'page' : undefined} className={`adm-tab${tab === t.id ? ' active' : ''}`} onClick={() => switchTab(t.id)}>
              {t.label}
              {!!t.badge && (
                <span className="adm-badge" aria-label={`${t.badge} atendimentos abertos`}>
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="adm-bar-right">
          <a className="adm-link" href="/">
            Ver o site
          </a>
          <button type="button" className="adm-link" onClick={() => void adminApi.logout().finally(() => location.reload())}>
            Sair
          </button>
        </div>
      </header>

      {loadError && (
        <div className="adm-banner" role="status">
          <span className="adm-spin" aria-hidden="true" />
          {loadError}
        </div>
      )}

      {tab === 'profissionais' ? (
        <ProvidersTab providers={providers} reload={loadProviders} notify={notify} />
      ) : tab === 'recrutamento' ? (
        <RecruitingTab onPromoted={loadProviders} notify={notify} serviceOptions={allServices(providers)} />
      ) : (
        <ConversationsTab inbox={inbox} tick={inboxTick} reload={loadInbox} />
      )}

      {toast && (
        <div className="adm-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

const allServices = (ps: AdminProvider[] | null) => [...new Set((ps ?? []).flatMap((p) => p.categories))];

/* ------------------------------------------------------------------ */
/* Profissionais                                                       */
/* ------------------------------------------------------------------ */

type Group = 'todos' | 'ativos' | 'esperando' | 'pausados' | 'fora';
const GROUPS: { id: Group; label: string; has: (s: ProviderStatus) => boolean }[] = [
  { id: 'todos', label: 'Todos', has: () => true },
  { id: 'ativos', label: 'Ativos', has: (s) => s === 'ativo' },
  { id: 'esperando', label: 'Esperando', has: (s) => s === 'convidado' },
  { id: 'pausados', label: 'Pausados', has: (s) => s === 'pausado' },
  { id: 'fora', label: 'Fora', has: (s) => s === 'saiu' || s === 'bloqueado' },
];

type Panel = { kind: 'add' } | { kind: 'edit'; id: number } | null;

function ProvidersTab({ providers, reload, notify }: { providers: AdminProvider[] | null; reload: () => void; notify: (m: string) => void }) {
  const [panel, setPanel] = useState<Panel>(null);
  const [filter, setFilter] = useState('');
  const [group, setGroup] = useState<Group>('todos');
  const [blocking, setBlocking] = useState<AdminProvider | null>(null);

  const shown = useMemo(() => {
    if (!providers) return null;
    const q = filter.trim().toLowerCase();
    const has = GROUPS.find((g) => g.id === group)!.has;
    return providers.filter(
      (p) =>
        has(p.status) &&
        (!q || [p.name, p.phone_display, p.phone, p.categories.join(' '), regionsText(p)].join(' ').toLowerCase().includes(q)),
    );
  }, [providers, filter, group]);

  const act = async (fn: () => Promise<string | null>) => {
    try {
      const text = await fn();
      if (text) notify(text);
      reload();
    } catch (e) {
      notify(errMsg(e));
    }
  };
  const resend = (p: AdminProvider) =>
    act(async () => {
      const r = await adminApi.invite(p.id);
      return r.sent ? `Confirmação reenviada pra ${p.name}.` : `Não reenviei${r.reason ? `: ${r.reason}` : ''}.`;
    });
  const setStatus = (p: AdminProvider, status: 'ativo' | 'pausado' | 'bloqueado') =>
    act(async () => {
      await adminApi.updateProvider(p.id, { status });
      return null;
    });

  const menuFor = (p: AdminProvider): MenuItem[] => [
    { label: 'Editar', onClick: () => setPanel({ kind: 'edit', id: p.id }) },
    ...(p.status !== 'ativo' && p.status !== 'bloqueado' ? [{ label: 'Reenviar confirmação', onClick: () => void resend(p) }] : []),
    p.status === 'ativo' || p.status === 'convidado'
      ? { label: 'Pausar', onClick: () => void setStatus(p, 'pausado') }
      : { label: 'Ativar', onClick: () => void setStatus(p, 'ativo') },
    ...(p.status !== 'bloqueado' ? [{ label: 'Bloquear', danger: true, onClick: () => setBlocking(p) }] : []),
  ];

  const editing = panel?.kind === 'edit' ? providers?.find((p) => p.id === panel.id) : null;

  return (
    <main className="adm-page">
      <div className="adm-page-head">
        <h1>Profissionais</h1>
        <button type="button" className="abtn primary" onClick={() => setPanel({ kind: 'add' })}>
          Adicionar profissional
        </button>
      </div>

      <div className="adm-toolbar">
        <div className="adm-groups" role="group" aria-label="Filtrar por situação">
          {GROUPS.map((g) => {
            const n = providers?.filter((p) => g.has(p.status)).length ?? 0;
            return (
              <button key={g.id} type="button" aria-pressed={group === g.id} className={group === g.id ? 'on' : ''} onClick={() => setGroup(g.id)}>
                {g.label} <span>{n}</span>
              </button>
            );
          })}
        </div>
        <div className="adm-search">
          <IconSearch />
          <label className="sr-only" htmlFor="adm-filter">
            Buscar profissionais
          </label>
          <input id="adm-filter" type="search" placeholder="Buscar por nome, serviço ou bairro" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>

      <div className="adm-table-wrap">
        {!shown ? (
          <p className="adm-empty">Carregando…</p>
        ) : shown.length === 0 ? (
          providers?.length ? (
            <p className="adm-empty">Ninguém com esse filtro.</p>
          ) : (
            <div className="adm-empty">
              <strong>Nenhum profissional ainda</strong>
              <span>Quem tu adicionar recebe um pedido de confirmação no WhatsApp.</span>
            </div>
          )
        ) : (
          <table className="adm-table">
            <thead>
              <tr>
                <th>Profissional</th>
                <th>Serviços</th>
                <th>Região</th>
                <th>Situação</th>
                <th>Nota</th>
                <th>
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => setPanel({ kind: 'edit', id: p.id })}>
                  <td data-cell="main">
                    <button type="button" className="cell-title" onClick={(e) => { e.stopPropagation(); setPanel({ kind: 'edit', id: p.id }); }}>
                      {p.name}
                    </button>
                    <div className="cell-sub">{p.phone_display || p.phone || 'sem telefone'}</div>
                  </td>
                  <td>{p.categories.join(', ') || 'sem serviço'}</td>
                  <td className="cell-region">{regionsText(p)}</td>
                  <td>
                    <StatusDot status={p.status} />
                  </td>
                  <td className="cell-num">{p.our_rating_count > 0 && p.our_rating_avg != null ? `${p.our_rating_avg.toFixed(1)} (${p.our_rating_count})` : <span className="cell-none">-</span>}</td>
                  <td className="cell-actions">
                    <ActionsMenu label={`Ações de ${p.name}`} items={menuFor(p)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {panel?.kind === 'add' && (
        <AddProvider
          serviceOptions={allServices(providers)}
          onClose={() => setPanel(null)}
          onAdded={(msg) => {
            notify(msg);
            reload();
          }}
        />
      )}
      {editing && (
        <EditProvider
          key={editing.id}
          p={editing}
          serviceOptions={allServices(providers)}
          onClose={() => setPanel(null)}
          onSaved={reload}
          onResend={() => void resend(editing)}
        />
      )}
      {blocking && (
        <ConfirmDialog
          danger
          title={`Bloquear ${blocking.name}?`}
          text="Deixa de receber pedidos. Dá pra ativar de novo depois."
          confirmLabel="Bloquear"
          onClose={() => setBlocking(null)}
          onConfirm={() => {
            void setStatus(blocking, 'bloqueado');
            setBlocking(null);
          }}
        />
      )}
    </main>
  );
}

function StatusDot({ status }: { status: ProviderStatus }) {
  return <span className={`status-dot st-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

function AddProvider({ serviceOptions, onClose, onAdded }: { serviceOptions: string[]; onClose: () => void; onAdded: (msg: string) => void }) {
  const [d, setD] = useState<ProviderDraft>({ name: '', phone: '', services: [], coverage: { city: 'Porto Alegre', neighborhoods: null }, notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draftOk(d, true) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await adminApi.createProvider({
        name: d.name,
        phone: d.phone,
        categories: d.services,
        city: d.coverage.city,
        neighborhoods: d.coverage.neighborhoods ?? [],
        notes: d.notes.trim() || null,
      });
      onAdded(
        r.invite.sent
          ? `Pedido de confirmação enviado no WhatsApp pra ${d.name.trim().split(/\s+/)[0]}.`
          : `Salvo, mas a confirmação não foi enviada${r.invite.reason ? `: ${r.invite.reason}` : ''}.`,
      );
      onClose();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <Drawer
      title="Adicionar profissional"
      subtitle="Só recebe pedidos depois de confirmar no WhatsApp."
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          {error && <p className="error-text">{error}</p>}
          <div className="drawer-actions">
            <button type="button" className="abtn" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="abtn primary" disabled={busy || !draftOk(d, true) || !phoneOk(d.phone)}>
              {busy ? 'Enviando…' : 'Adicionar e pedir confirmação'}
            </button>
          </div>
        </>
      }
    >
      <ProviderFields value={d} onChange={setD} phone="editable" serviceOptions={serviceOptions} />
    </Drawer>
  );
}

function EditProvider({ p, serviceOptions, onClose, onSaved, onResend }: { p: AdminProvider; serviceOptions: string[]; onClose: () => void; onSaved: () => void; onResend: () => void }) {
  const city = p.regions[0]?.city ?? 'Porto Alegre';
  const hoods = p.regions.filter((r) => r.city === city && r.neighborhood).map((r) => r.neighborhood!);
  const [d, setD] = useState<ProviderDraft>({ name: p.name, phone: '', services: p.categories, coverage: { city, neighborhoods: hoods.length ? hoods : null }, notes: p.notes ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draftOk(d, false) || busy) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.updateProvider(p.id, {
        name: d.name,
        categories: d.services,
        city: d.coverage.city,
        neighborhoods: d.coverage.neighborhoods ?? [],
        notes: d.notes,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <Drawer
      title={p.name}
      subtitle={<StatusDot status={p.status} />}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          {error && <p className="error-text">{error}</p>}
          <div className="drawer-actions">
            <button type="button" className="abtn" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="abtn primary" disabled={busy || !draftOk(d, false)}>
              {busy ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </>
      }
    >
      <ProviderFields value={d} onChange={setD} phone={p.phone_display || p.phone || 'sem telefone'} serviceOptions={serviceOptions} />
      <dl className="facts">
        <div>
          <dt>Confirmação</dt>
          <dd>
            {p.opt_out_at ? (
              `Pediu pra sair em ${fmtDate(p.opt_out_at)}`
            ) : p.opt_in_at ? (
              <>
                Confirmou em {fmtDate(p.opt_in_at)}
                {p.opt_in_text && <small>{p.opt_in_text}</small>}
              </>
            ) : (
              <>
                Cadastrado em {fmtDate(p.created_at, false)}, ainda sem confirmar.{' '}
                {p.status !== 'bloqueado' && (
                  <button type="button" className="adm-inline" onClick={onResend}>
                    Reenviar
                  </button>
                )}
              </>
            )}
          </dd>
        </div>
        {p.paused_until && p.status === 'pausado' && (
          <div>
            <dt>Pausado até</dt>
            <dd>{fmtDate(p.paused_until)}</dd>
          </div>
        )}
      </dl>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Conversas                                                           */
/* ------------------------------------------------------------------ */

function WindowTag({ open }: { open: boolean }) {
  return <span className={`win${open ? ' on' : ''}`}>{open ? 'Janela aberta' : 'Janela fechada'}</span>;
}

function ConversationsTab({ inbox, tick, reload }: { inbox: Inbox | null; tick: number; reload: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);

  const handoffFor = (phone: string): Handoff | undefined => inbox?.handoffs.find((h) => h.phone === phone);
  const others = inbox ? inbox.conversations.filter((c) => !inbox.handoffs.some((h) => h.phone === c.phone)) : [];

  return (
    <div className={`inbox${selected ? ' has-sel' : ''}`}>
      <aside className="inbox-list" aria-label="Conversas">
        {!inbox ? (
          <p className="adm-empty">Carregando…</p>
        ) : (
          <>
            {inbox.handoffs.length > 0 && (
              <>
                <h2 className="inbox-label">Precisam de atendimento</h2>
                <ul>
                  {inbox.handoffs.map((h) => (
                    <li key={`h${h.id}`}>
                      <button type="button" className={`inbox-item${selected === h.phone ? ' active' : ''}`} aria-current={selected === h.phone ? 'true' : undefined} onClick={() => setSelected(h.phone)}>
                        <span className="inbox-top">
                          <strong>{h.provider_name ?? h.phone_display}</strong>
                          <time>{fmtShort(h.created_at)}</time>
                        </span>
                        <span className="inbox-reason">{h.reason || 'Sem motivo informado'}</span>
                        <WindowTag open={h.window_open} />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h2 className="inbox-label">Recentes</h2>
            {others.length === 0 ? (
              <p className="adm-empty small">Nenhuma conversa ainda.</p>
            ) : (
              <ul>
                {others.map((c) => (
                  <li key={c.phone}>
                    <button type="button" className={`inbox-item${selected === c.phone ? ' active' : ''}`} aria-current={selected === c.phone ? 'true' : undefined} onClick={() => setSelected(c.phone)}>
                      <span className="inbox-top">
                        <strong>{c.name ?? c.phone_display}</strong>
                        <time>{fmtShort(c.last_at)}</time>
                      </span>
                      <WindowTag open={c.window_open} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </aside>

      <section className="inbox-thread" aria-label="Conversa selecionada">
        {selected ? (
          <ThreadView key={selected} phone={selected} handoff={handoffFor(selected)} tick={tick} onBack={() => setSelected(null)} reloadInbox={reload} />
        ) : (
          <p className="adm-empty center">Escolhe uma conversa.</p>
        )}
      </section>
    </div>
  );
}

function ThreadView({ phone, handoff, tick, onBack, reloadInbox }: { phone: string; handoff: Handoff | undefined; tick: number; onBack: () => void; reloadInbox: () => void }) {
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
    <div className="thread-view">
      <header className="thread-head">
        <button type="button" className="adm-icon thread-back" aria-label="Voltar pra lista" onClick={onBack}>
          <IconBack />
        </button>
        <div className="thread-title">
          <h2>{handoff?.provider_name ?? t?.phone_display ?? phone}</h2>
          <div>
            {handoff?.provider_name && <span>{t?.phone_display}</span>}
            <WindowTag open={windowOpen} />
            {t?.opt_out_at && <span className="txt-danger">Pediu pra sair</span>}
          </div>
        </div>
      </header>

      {handoff && (
        <div className="handoff">
          <div>
            <strong>Atendimento aberto</strong>
            <span>{handoff.reason || 'Sem motivo informado'}</span>
          </div>
          <div className="handoff-actions">
            <button type="button" className="abtn" disabled={closing} onClick={() => close(false)}>
              Encerrar
            </button>
            <button type="button" className="abtn primary" disabled={closing} onClick={() => close(true)}>
              Devolver pro agente
            </button>
          </div>
        </div>
      )}

      <div className="msgs" ref={scrollRef}>
        {!t ? (
          <p className="adm-empty center">{error ? '' : 'Carregando…'}</p>
        ) : t.messages.length === 0 ? (
          <p className="adm-empty center">Sem mensagens.</p>
        ) : (
          t.messages.map((m, i) => (
            <div key={i} className={`msg ${m.dir}${m.error ? ' failed' : ''}`}>
              {m.dir === 'out' && m.template && <div className="msg-tpl">{m.template}</div>}
              <div className="msg-text">{m.text || <em>(sem texto)</em>}</div>
              {m.error && (
                <div className="msg-err">
                  {m.state === 'blocked' ? 'Bloqueada' : 'Falhou'}: {m.error}
                </div>
              )}
              <div className="msg-meta">
                {fmtDate(m.at)}
                {m.dir === 'out' && (m.delivery || m.state) && <> · {m.delivery ?? m.state}</>}
              </div>
            </div>
          ))
        )}
      </div>

      {error && (
        <p className="error-text thread-error" role="alert">
          {error}
        </p>
      )}

      <form className="reply" onSubmit={send}>
        {t && !windowOpen ? (
          <p className="reply-closed">Janela de 24h fechada. Só dá pra responder quando a pessoa escrever de novo.</p>
        ) : (
          <div className="reply-box">
            <label className="sr-only" htmlFor="adm-reply-text">
              Resposta
            </label>
            <textarea
              id="adm-reply-text"
              rows={2}
              placeholder="Escreve a resposta"
              value={text}
              disabled={sending}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button type="submit" className="abtn primary reply-send" aria-label="Enviar" disabled={sending || !text.trim()}>
              <IconSend />
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
