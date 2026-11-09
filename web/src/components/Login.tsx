import { useState, type FormEvent } from 'react';
import { api, ApiError, type Settings } from '../api';
import { CodeInput, PhoneInput, phoneOk } from './fields';

/**
 * Entrar com o celular: o código chega no WhatsApp. Primeira vez = cadastro.
 * `inline`: dentro de um cartão ou janela (ex.: antes de pedir orçamentos), sem a caixa de página.
 */
export function Login({
  onDone,
  inline = false,
  title = 'Entrar no Desenrola',
  intro = 'Teu celular é teu login. Te mando um código no WhatsApp, sem senha.',
  submitLabel = 'Entrar',
  askName = false,
  hideTitle = false,
}: {
  onDone: (me: Settings) => void;
  inline?: boolean;
  title?: string;
  intro?: string;
  submitLabel?: string;
  /** pede o nome junto (vai pro profissional quando o cliente aprovar) */
  askName?: boolean;
  /** quem envolve já mostra o título */
  hideTitle?: boolean;
}) {
  const [name, setName] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestCode = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.requestCode(phone);
      setDevCode(r.dev_code ?? null);
      setStep('code');
      setCode('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não consegui mandar o código agora.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string) => {
    if (busy || value.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      let me = await api.verifyCode(phone, value, consent);
      if (askName && name.trim() && !me.user_name) me = await api.putSettings({ user_name: name.trim() });
      onDone(me);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não consegui entrar agora.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const box = inline ? 'login-inline' : 'ob-box';
  const H = inline ? 'h3' : 'h1';
  const content = (
    <>
      {step === 'phone' ? (
        <form className={box} onSubmit={requestCode}>
          {!hideTitle && <H>{title}</H>}
          <p>{intro}</p>
          {askName && (
            <label className="field" htmlFor="login-name">
              Teu nome
              <input id="login-name" className="ob-input" autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          <label className="field" htmlFor="login-phone">
            Celular com WhatsApp
            <PhoneInput id="login-phone" autoFocus={!askName} value={phone} onChange={setPhone} />
          </label>
          <label className="consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>Quero receber pelo WhatsApp os avisos dos meus pedidos (orçamentos e perguntas dos profissionais).</span>
          </label>
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="btn dark ob-submit" disabled={busy || !phoneOk(phone) || (askName && !name.trim())}>
            {busy ? 'Enviando…' : 'Receber código'}
          </button>
        </form>
      ) : (
        <form
          className={box}
          onSubmit={(e) => {
            e.preventDefault();
            void verify(code);
          }}
        >
          <H>Digita o código</H>
          <p>Mandei 6 números pro WhatsApp do {phone}.</p>
          {devCode && <p className="note">Modo de teste (sem Twilio): o código é {devCode}.</p>}
          <label className="sr-only" htmlFor="login-code">
            Código
          </label>
          <CodeInput id="login-code" value={code} onChange={setCode} onComplete={(v) => void verify(v)} />
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="btn dark ob-submit" disabled={busy || code.length !== 6}>
            {busy ? 'Entrando…' : submitLabel}
          </button>
          <div className="ob-links">
            <button type="button" className="link-btn" onClick={() => setStep('phone')}>
              Trocar número
            </button>
            <button type="button" className="link-btn" disabled={busy} onClick={() => void requestCode()}>
              Mandar de novo
            </button>
          </div>
        </form>
      )}
    </>
  );
  return inline ? content : <section className="home">{content}</section>;
}
