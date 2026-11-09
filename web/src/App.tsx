import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { api, subscribe, STATUS_LABEL, type Message, type RequestDetail, type RequestSummary, type Settings as SettingsData, type StreamEvent } from './api';
import { Conversation } from './components/Conversation';
import { MiniMap, Onboarding } from './components/Onboarding';
import { AdminGate } from './admin/AdminGate';
import { ProSignup } from './pro/ProSignup';
import { Login } from './components/Login';
import { ComboInput, NeighborhoodInput, phoneDigits, phoneOk } from './components/fields';
import { Composer, IconGear, IconMenu, IconPhone, IconPlus, IconX } from './components/ui';
import { CITIES } from './lib/options';

const idFromHash = () => {
  const m = location.hash.match(/^#\/p\/(\d+)/);
  return m ? Number(m[1]) : null;
};

/** "5551999998888" -> "(51) 99999-8888" */
export const formatPhone = (e164: string) => {
  const d = e164.replace(/\D/g, '').replace(/^55/, '');
  return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : e164;
};

/** Ícone provisório: fio enrolado que vira linha reta com um ponto (o logo ainda vai mudar). */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.7} height={size * 0.7} viewBox="0 0 48 48" fill="none">
        <path d="M7 31c0-11 14-15 16-7 2 8-10 9-8 1 2-7 12-9 26-9" stroke="#0E1626" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="41" cy="16" r="3.6" fill="#0E1626" />
      </svg>
    </span>
  );
}

export function App() {
  if (location.pathname.startsWith('/admin')) return <AdminGate />;
  if (location.pathname.startsWith('/profissional')) return <ProSignup />;
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

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [menuOpen]);

  // Celular: arrastar o dedo puxa o histórico (pra direita) e volta pra conversa (pra esquerda).
  const appRef = useRef<HTMLDivElement>(null);
  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;
  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    const main = app.querySelector<HTMLElement>('.main')!;
    const sidebar = app.querySelector<HTMLElement>('.sidebar')!;
    const narrow = matchMedia('(max-width: 760px)');
    let drag: { x0: number; y0: number; open: boolean; width: number; active: boolean; x: number; lastX: number; lastT: number; speed: number } | null = null;

    const release = () => {
      main.style.transform = '';
      main.style.borderRadius = '';
      app.classList.remove('dragging');
    };
    const onStart = (e: TouchEvent) => {
      drag = null;
      // nos campos de texto o dedo serve pra selecionar e mover o cursor
      if (!narrow.matches || e.touches.length !== 1 || (e.target as Element).closest('input, textarea, select')) return;
      const t = e.touches[0];
      const open = menuOpenRef.current;
      const width = sidebar.offsetWidth;
      drag = { x0: t.clientX, y0: t.clientY, open, width, active: false, x: open ? width : 0, lastX: t.clientX, lastT: e.timeStamp, speed: 0 };
    };
    const onMove = (e: TouchEvent) => {
      if (!drag) return;
      const t = e.touches[0];
      const dx = t.clientX - drag.x0;
      const dy = t.clientY - drag.y0;
      if (!drag.active) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        // rolando a lista, ou arrastando pro lado que não leva a lugar nenhum: deixa como está
        if (Math.abs(dy) >= Math.abs(dx) || (dx > 0) === drag.open) {
          drag = null;
          return;
        }
        drag.active = true;
        app.classList.add('dragging');
      }
      e.preventDefault();
      const dt = e.timeStamp - drag.lastT;
      if (dt > 0) drag.speed = (t.clientX - drag.lastX) / dt;
      drag.lastX = t.clientX;
      drag.lastT = e.timeStamp;
      drag.x = Math.max(0, Math.min(drag.width, (drag.open ? drag.width : 0) + dx));
      main.style.transform = `translateX(${drag.x}px)`;
      main.style.borderRadius = `${Math.round((drag.x / drag.width) * 26)}px 0 0 ${Math.round((drag.x / drag.width) * 26)}px`;
    };
    const onEnd = (e: TouchEvent) => {
      if (!drag?.active) {
        drag = null;
        return;
      }
      // um gesto rápido decide pelo sentido; um devagar, ou que parou antes de soltar, por onde o painel ficou
      const fast = e.timeStamp - drag.lastT < 100 && Math.abs(drag.speed) > 0.4;
      const open = fast ? drag.speed > 0 : drag.x > drag.width / 2;
      drag = null;
      flushSync(() => setMenuOpen(open));
      release(); // solta do dedo: a animação normal leva até o fim a partir de onde parou
    };
    const onCancel = () => {
      drag = null;
      release();
    };
    app.addEventListener('touchstart', onStart, { passive: true });
    app.addEventListener('touchmove', onMove, { passive: false });
    app.addEventListener('touchend', onEnd);
    app.addEventListener('touchcancel', onCancel);
    return () => {
      app.removeEventListener('touchstart', onStart);
      app.removeEventListener('touchmove', onMove);
      app.removeEventListener('touchend', onEnd);
      app.removeEventListener('touchcancel', onCancel);
    };
  }, [auth]);

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
      <div ref={appRef} className={`app${menuOpen ? ' menu-open' : ''}`}>
        <nav aria-label="Histórico" className={`sidebar glass${menuOpen ? ' open' : ''}`}>
          <div className="brand-row">
            <span className="brand">
              <BrandMark />
              desenrola
            </span>
          </div>
          <button type="button" className={`nav-item desk-only${currentId == null ? ' active' : ''}`} onClick={() => go(null)}>
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
            <button type="button" className="nav-item wa-button nav-login" onClick={() => { setMenuOpen(false); setPanel('login'); }}>
              <IconPhone /> Entrar com celular
            </button>
          )}
          <button type="button" className="nav-item wa-button desk-only" onClick={() => setPanel('settings')}>
            <IconGear /> Configurações
          </button>
          {/* no celular, os dois comandos ficam fixos embaixo do painel */}
          <div className="drawer-bar">
            <button type="button" className="round-btn" aria-label="Configurações" onClick={() => { setMenuOpen(false); setPanel('settings'); }}>
              <IconGear />
            </button>
            <button type="button" className="new-pill" onClick={() => go(null)}>
              <IconPlus /> Novo problema
            </button>
          </div>
        </nav>

        <main className="main">
          <div className="mobile-bar">
            <button type="button" className="round-btn" aria-label={menuOpen ? 'Fechar histórico' : 'Abrir histórico'} aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
              <IconMenu />
            </button>
            {currentId == null && (
              <span className="brand mobile-brand">
                <BrandMark size={26} />
                desenrola
              </span>
            )}
          </div>
          {/* com o painel aberto, tocar na conversa fecha */}
          {menuOpen && <button type="button" className="main-scrim" aria-label="Fechar histórico" onClick={() => setMenuOpen(false)} />}
          {currentId == null && settings && !settings.is_guest && !settings.onboarding_done ? (
            <Onboarding
              initial={{ user_name: settings.user_name, user_city: settings.user_city, user_neighborhood: settings.user_neighborhood }}
              onDone={() => api.getSettings().then(setSettings).catch(() => setSettings({ ...settings, onboarding_done: true }))}
            />
          ) : currentId == null ? (
            <section className="home">
              <h1>
                Qual problema você precisa resolver?
              </h1>
              <Composer
                id="ask"
                label="Descreva o problema"
                big
                autoFocus
                placeholder="Ex.: a tomada da cozinha está faiscando quando ligo a air fryer"
                onSend={start}
              />
              {noKey && <p className="hint">Falta a ANTHROPIC_API_KEY no arquivo .env — sem ela eu não consigo responder.</p>}
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
        <Dialog title="Entrar com celular" onClose={() => setPanel(null)}>
          <Login
            inline
            hideTitle
            intro=""
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
          onLoggedIn={(me) => {
            setSettings(me);
            void loadList();
          }}
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

function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn dialog-x" aria-label="Fechar" onClick={onClose}>
            <IconX />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>
  );
}

function Settings({ onClose, onLoggedIn }: { onClose: () => void; onLoggedIn: (me: SettingsData) => void }) {
  const [s, setS] = useState({ user_name: '', user_city: '', user_neighborhood: '', user_phone: '' });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // mesmo mapa do onboarding: o lugar confirmado no mapa (nome corrigido) é o que salva
  const [mapReady, setMapReady] = useState(false);
  const [place, setPlace] = useState<{ city: string; neighborhood: string } | null>(null);
  useEffect(() => {
    api
      .getSettings()
      .then((d) => {
        setS({ user_name: d.user_name, user_city: d.user_city, user_neighborhood: d.user_neighborhood, user_phone: d.user_phone ? formatPhone(d.user_phone) : '' });
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);
  // número digitado e ainda sem confirmar: o Salvar pede o código e salva tudo depois de confirmar
  const [login, setLogin] = useState<{ phone: string; step: 'phone' | 'code' }>({ phone: '', step: 'phone' });
  const [sendCode, setSendCode] = useState(0);
  const saveAfterLogin = useRef(false);
  const save = (values = s) => {
    if (!values.user_phone && login.phone) {
      if (!phoneOk(login.phone)) {
        setError(phoneDigits(login.phone).length ? 'Completa o celular ou apaga o número.' : null);
        return;
      }
      saveAfterLogin.current = true;
      setError(null);
      setSendCode((n) => n + 1);
      return;
    }
    setBusy(true);
    setError(null);
    api
      .putSettings({
        user_name: values.user_name,
        user_city: (place?.city ?? values.user_city).trim(),
        user_neighborhood: (place?.neighborhood ?? values.user_neighborhood).trim(),
      })
      .then(onClose)
      .catch((e) => {
        setError(e instanceof Error && e.message ? e.message : 'Não consegui salvar.');
        setBusy(false);
      });
  };
  return (
    <Dialog
      title="Configurações"
      onClose={onClose}
      footer={
        <>
          {error && <p className="error-text">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancelar
            </button>
            <button type="button" className="btn dark" disabled={busy || login.step === 'code' || (!!s.user_neighborhood.trim() && !mapReady)} onClick={() => save()}>
              {busy ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </>
      }
    >
      <label className="field" htmlFor="set-name">
        Teu nome
        <input id="set-name" className="ob-input" autoComplete="given-name" value={s.user_name} onChange={(e) => setS({ ...s, user_name: e.target.value })} />
      </label>
      {s.user_phone ? (
        <div className="field">
          <span>Celular com WhatsApp</span>
          <div className="field-static split">
            <span>{s.user_phone}</span>
            <button type="button" className="link-btn" onClick={() => void api.logout().finally(() => location.reload())}>
              Sair da conta
            </button>
          </div>
          <span className="field-help">O profissional só recebe quando tu aprovar um orçamento.</span>
        </div>
      ) : (
        <Login
          inline
          compact
          hideTitle
          intro=""
          submitLabel="Confirmar"
          sendCodeSignal={sendCode}
          onChange={setLogin}
          onDone={(me) => {
            // entrou na conta desse número: o que a pessoa já digitou aqui continua valendo
            const next = {
              user_name: s.user_name || me.user_name,
              user_city: s.user_city || me.user_city,
              user_neighborhood: s.user_neighborhood || me.user_neighborhood,
              user_phone: me.user_phone ? formatPhone(me.user_phone) : '',
            };
            setS(next);
            setLogin({ phone: '', step: 'phone' });
            onLoggedIn(me);
            if (saveAfterLogin.current) save(next);
          }}
        />
      )}
      <div className="field-row">
        <div className="field">
          <label htmlFor="set-city">Cidade</label>
          <ComboInput id="set-city" value={s.user_city} options={CITIES} autoComplete="address-level2" onChange={(user_city) => setS({ ...s, user_city })} />
        </div>
        <div className="field">
          <label htmlFor="set-hood">Bairro</label>
          <NeighborhoodInput id="set-hood" city={s.user_city} value={s.user_neighborhood} onChange={(user_neighborhood) => setS({ ...s, user_neighborhood })} />
        </div>
      </div>
      {loaded && <MiniMap city={s.user_city} hood={s.user_neighborhood} onReady={setMapReady} onPlace={setPlace} />}
    </Dialog>
  );
}
