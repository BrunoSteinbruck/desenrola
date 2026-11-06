import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, subscribe, STATUS_LABEL, type Message, type RequestDetail, type RequestSummary, type StreamEvent, type WaState } from './api';
import { Conversation } from './components/Conversation';
import { WhatsappPanel } from './components/Cards';
import { Composer, IconGear, IconMenu, IconPlus } from './components/ui';

const idFromHash = () => {
  const m = location.hash.match(/^#\/p\/(\d+)/);
  return m ? Number(m[1]) : null;
};

export function App() {
  const [requests, setRequests] = useState<RequestSummary[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(idFromHash);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [streaming, setStreaming] = useState<Message | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [wa, setWa] = useState<WaState>({ status: 'desconectado', qr: null, me: null });
  const [toast, setToast] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [noKey, setNoKey] = useState(false);
  const [panel, setPanel] = useState<'whatsapp' | 'settings' | null>(null);
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
    if (currentId != null) loadDetail(currentId);
  }, [currentId, loadDetail]);

  useEffect(() => {
    void loadList();
    api.whatsapp().then(setWa).catch(() => {});
    api.health().then((h) => setNoKey(!h.claude)).catch(() => {});
  }, [loadList]);

  // Tempo real
  useEffect(() => {
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
        case 'wa.status':
          setWa((w) => ({ ...w, status: e.status, qr: e.qr, me: e.me }));
          break;
      }
    };
    return subscribe(onEvent, () => {
      void loadList();
      api.whatsapp().then(setWa).catch(() => {});
      if (currentRef.current != null) loadDetail(currentRef.current);
    });
  }, [loadList, loadDetail]);

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

  const waLabel =
    wa.status === 'conectado' ? 'WhatsApp conectado' : wa.status === 'qr' ? 'Escaneie o QR code' : wa.status === 'conectando' ? 'Conectando…' : 'Conectar WhatsApp';

  return (
    <>
      <div className="backdrop" aria-hidden="true">
        <span className="b1" />
        <span className="b2" />
        <span className="b3" />
      </div>
      <div className="app">
        <nav aria-label="Histórico" className={`sidebar glass${menuOpen ? ' open' : ''}`}>
          <div className="brand-row">
            <span className="brand">Resolvedor</span>
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
          <button type="button" className="nav-item wa-button" onClick={() => setPanel('whatsapp')}>
            <span className={`dot${wa.status === 'conectado' ? ' on' : wa.status === 'desconectado' ? '' : ' wait'}`} aria-hidden="true" />
            {waLabel}
          </button>
          <button type="button" className="nav-item wa-button" onClick={() => setPanel('settings')}>
            <IconGear /> Configurações
          </button>
        </nav>

        <main className="main">
          {currentId == null ? (
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
                  : 'O diagnóstico é grátis. Você só paga quando eu chamar os profissionais.'}
              </p>
            </section>
          ) : detail ? (
            <Conversation detail={detail} streaming={streaming} wa={wa} waiting={waiting} onError={showError} />
          ) : null}
        </main>
      </div>

      {panel === 'whatsapp' && (
        <Dialog title="WhatsApp" onClose={() => setPanel(null)}>
          <WhatsappPanel wa={wa} onError={showError} />
          {wa.status === 'conectado' && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => api.logoutWhatsapp().catch(() => showError('Não consegui desconectar.'))}
            >
              Desconectar
            </button>
          )}
        </Dialog>
      )}
      {panel === 'settings' && <Settings onClose={() => setPanel(null)} onError={showError} />}

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
    api.getSettings().then(setS).catch(() => {});
  }, []);
  const field = (key: string, label: string, type = 'text', placeholder = '') => (
    <label className="field">
      {label}
      <input type={type} value={s[key] ?? ''} placeholder={placeholder} onChange={(e) => setS({ ...s, [key]: e.target.value })} />
    </label>
  );
  return (
    <Dialog title="Configurações" onClose={onClose}>
      {field('user_name', 'Teu nome (eu me apresento como teu assistente)', 'text', 'Bruno')}
      {field('user_city', 'Cidade', 'text', 'Porto Alegre')}
      {field('user_email', 'E-mail (exigido pelo Pix)', 'email')}
      <button
        type="button"
        className="btn dark"
        onClick={() =>
          api
            .putSettings({ user_name: s.user_name ?? '', user_city: s.user_city ?? '', user_email: s.user_email ?? '' })
            .then(onClose)
            .catch(() => onError('Não consegui salvar.'))
        }
      >
        Salvar
      </button>
    </Dialog>
  );
}
