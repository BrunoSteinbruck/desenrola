import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, subscribe, STATUS_LABEL, type Message, type RequestDetail, type RequestSummary, type Settings as SettingsData, type StreamEvent } from './api';
import { Conversation } from './components/Conversation';
import { Onboarding } from './components/Onboarding';
import { AdminGate } from './admin/AdminGate';
import { Login } from './components/Login';
import { Composer, IconGear, IconMenu, IconPlus } from './components/ui';

const idFromHash = () => {
  const m = location.hash.match(/^#\/p\/(\d+)/);
  return m ? Number(m[1]) : null;
};

/** "5551999998888" -> "(51) 99999-8888" */
export const formatPhone = (e164: string) => {
  const d = e164.replace(/\D/g, '').replace(/^55/, '');
  return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : e164;
};

export function App() {
  if (location.pathname.startsWith('/admin')) return <AdminGate />;
  return <ClientApp />;
}

function ClientApp() {
  const [requests, setRequests] = useState<RequestSummary[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(idFromHash);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [streaming, setStreaming] = useState<Message | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [noKey, setNoKey] = useState(false);
  const [paymentsOn, setPaymentsOn] = useState(false);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [auth, setAuth] = useState<'checking' | 'out' | 'in'>('checking');
  const [panel, setPanel] = useState<'settings' | 'login' | null>(null);
  const currentRef = useRef(currentId);
  currentRef.current = currentId;

  const showError = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }, []);

  const loadList = useCallback(() => api.listRequests().then(setRequests).catch(() => {}), []);
  const loadDetail = useCallback((id: number) => {
    api
      .getRequest(id)
      .then((d) => {
        if (currentRef.current === id) setDetail(d);
      })
      .catch(() => {
        if (currentRef.current === id) showError('Não encontrei esse pedido.');
      });
  }, [showError]);

  // Navegação por hash (#/p/12)
  useEffect(() => {
    const onHash = () => setCurrentId(idFromHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    setStreaming(null);
    setWaiting(false);
    setDetail(null);
    if (currentId != null && auth === 'in') loadDetail(currentId);
  }, [currentId, loadDetail, auth]);

  // quem está logado (cookie): sem sessão, mostra o login
  useEffect(() => {
    api
      .health()
      .then((h) => {
        setNoKey(!h.claude);
        setPaymentsOn(!!h.payments);
      })
      .catch(() => {});
    api.getSettings().then(
      (s) => {
        setSettings(s);
        setAuth('in');
      },
      () => setAuth('out'),
    );
  }, []);

  useEffect(() => {
    if (auth === 'in') void loadList();
  }, [auth, loadList]);

  // Tempo real
  useEffect(() => {
    if (auth !== 'in') return;
    const onEvent = (e: StreamEvent) => {
      const cur = currentRef.current;
      switch (e.type) {
        case 'message.delta':
          if (e.requestId !== cur) return;
          setWaiting(false);
          setStreaming((s) =>
            s && s.streamId === e.messageId
              ? { ...s, content: s.content + e.text }
              : { id: e.messageId, streamId: e.messageId, role: 'assistant', content: e.text, card: null, created_at: '', streaming: true },
          );
          break;
        case 'message.done':
          break;
        case 'message.created':
          if (e.requestId !== cur) {
            void loadList();
            return;
          }
          if (e.message.role !== 'user') setWaiting(false);
          setStreaming((s) => (s && (e.message.streamId === s.streamId || e.message.role === 'assistant') ? null : s));
          setDetail((d) => {
            if (!d || d.request.id !== e.requestId) return d;
            if (d.messages.some((m) => m.id === e.message.id)) return d;
            return { ...d, messages: [...d.messages, e.message] };
          });
          // cartões dependem de estado atualizado (prestadores, pagamento)
          if (e.message.card) loadDetail(e.requestId);
          break;
        case 'request.updated':
        case 'payment.updated':
          if (e.requestId === cur) loadDetail(e.requestId);
          void loadList();
          break;
        case 'requests.changed':
          void loadList();
          break;
      }
    };
    return subscribe(onEvent, () => {
      void loadList();
      if (currentRef.current != null) loadDetail(currentRef.current);
    });
  }, [loadList, loadDetail, auth]);

  const go = (id: number | null) => {
    location.hash = id == null ? '' : `#/p/${id}`;
    setMenuOpen(false);
  };

  const start = async (text: string) => {
    try {
      const { id } = await api.createRequest(text);
      go(id);
      setWaiting(true);
      void loadList();
    } catch {
      showError('Não consegui começar agora. O servidor está rodando?');
    }
  };

  const backdrop = (
    <div className="backdrop" aria-hidden="true">
      <span className="b1" />
      <span className="b2" />
      <span className="b3" />
    </div>
  );
  if (auth !== 'in') {
    return (
      <>
        {backdrop}
        {auth === 'out' && (
          <section className="home">
            <p className="hint">Não consegui falar com o servidor. Ele está rodando?</p>
          </section>
        )}
      </>
    );
  }

  return (
    <>
      {backdrop}
      <div className="app">
        <nav aria-label="Histórico" className={`sidebar glass${menuOpen ? ' open' : ''}`}>
          <div className="brand-row">
            <span className="brand">Desenrola</span>
            <button type="button" className="icon-btn menu-btn" aria-label="Abrir menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
              <IconMenu />
            </button>
          </div>
          <button type="button" className={`nav-item${currentId == null ? ' active' : ''}`} onClick={() => go(null)}>
            <IconPlus /> Novo problema
          </button>
          {requests.length > 0 && <p className="nav-label">Recentes</p>}
          <div className="history">
            {requests.map((r) => (
              <button key={r.id} type="button" className={`nav-item${r.id === currentId ? ' active' : ''}`} onClick={() => go(r.id)}>
                <span className="t">{r.title ?? 'Novo problema'}</span>
                <span className="s">{STATUS_LABEL[r.status] ?? r.status}</span>
              </button>
            ))}
          </div>
          {settings?.is_guest && (
            <button type="button" className="nav-item wa-button" onClick={() => setPanel('login')}>
              Entrar com celular
            </button>
          )}
          <button type="button" className="nav-item wa-button" onClick={() => setPanel('settings')}>
            <IconGear /> Configurações
          </button>
        </nav>

        <main className="main">
          {currentId == null && settings && !settings.is_guest && !settings.onboarding_done ? (
            <Onboarding
              initial={{ user_name: settings.user_name, user_city: settings.user_city, user_neighborhood: settings.user_neighborhood }}
              onDone={() => api.getSettings().then(setSettings).catch(() => setSettings({ ...settings, onboarding_done: true }))}
            />
          ) : currentId == null ? (
            <section className="home">
              <h1>Qual problema você quer resolver hoje?</h1>
              <Composer
                id="ask"
                label="Descreva o problema"
                big
                autoFocus
                placeholder="Ex.: a tomada da cozinha está faiscando quando ligo a air fryer"
                onSend={start}
              />
              <p className="hint">
                {noKey
                  ? 'Falta a ANTHROPIC_API_KEY no arquivo .env — sem ela eu não consigo responder.'
                  : 'Eu aviso profissionais da tua região e te trago os orçamentos. Tu compara e escolhe.'}
              </p>
            </section>
          ) : detail ? (
            <Conversation
              detail={detail}
              streaming={streaming}
              waiting={waiting}
              me={settings!}
              onLoggedIn={(me) => {
                setSettings(me);
                void loadList();
              }}
              paymentsOn={paymentsOn}
              onError={showError}
            />
          ) : null}
        </main>
      </div>

      {panel === 'login' && (
        <Dialog title="Entrar" onClose={() => setPanel(null)}>
          <Login
            inline
            title="Entrar com celular"
            intro="Pra ver teus pedidos em qualquer aparelho. Te mando um código no WhatsApp, sem senha."
            onDone={(me) => {
              setSettings(me);
              setPanel(null);
              void loadList();
            }}
          />
        </Dialog>
      )}
      {panel === 'settings' && (
        <Settings
          onClose={() => {
            setPanel(null);
            api.getSettings().then(setSettings).catch(() => {});
          }}
          onError={showError}
        />
      )}

      {toast && (
        <div role="status" className="glass" style={{ position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 20, padding: '10px 18px', borderRadius: 999, fontSize: 14 }}>
          {toast}
        </div>
      )}
    </>
  );
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog glass" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
        <div className="actions" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}

function Settings({ onClose, onError }: { onClose: () => void; onError: (m: string) => void }) {
  const [s, setS] = useState<Record<string, string>>({});
  useEffect(() => {
    api
      .getSettings()
      .then((d) => setS({ user_name: d.user_name, user_city: d.user_city, user_neighborhood: d.user_neighborhood, user_phone: d.user_phone ? formatPhone(d.user_phone) : '' }))
      .catch(() => {});
  }, []);
  const field = (key: string, label: string, type = 'text', placeholder = '') => (
    <label className="field">
      {label}
      <input type={type} value={s[key] ?? ''} placeholder={placeholder} onChange={(e) => setS({ ...s, [key]: e.target.value })} />
    </label>
  );
  return (
    <Dialog title="Configurações" onClose={onClose}>
      {field('user_name', 'Teu nome', 'text', 'Bruno')}
      {s.user_phone ? (
        <p className="note">
          Celular {s.user_phone}: é teu login e vai pro profissional quando tu aprovar um orçamento.{' '}
          <button type="button" className="link-btn" onClick={() => void api.logout().finally(() => location.reload())}>
            Sair
          </button>
        </p>
      ) : (
        <p className="note">Tu ainda não entrou com o celular. Ele só é pedido quando tu for pedir orçamentos.</p>
      )}
      <div className="field-row">
        {field('user_city', 'Cidade', 'text', 'Porto Alegre')}
        {field('user_neighborhood', 'Bairro', 'text', 'Bom Fim')}
      </div>
      <button
        type="button"
        className="btn dark"
        onClick={() =>
          api
            .putSettings({
              user_name: s.user_name ?? '',
              user_city: s.user_city ?? '',
              user_neighborhood: s.user_neighborhood ?? '',
            })
            .then(onClose)
            .catch((e) => onError(e instanceof Error && e.message ? e.message : 'Não consegui salvar.'))
        }
      >
        Salvar
      </button>
    </Dialog>
  );
}
