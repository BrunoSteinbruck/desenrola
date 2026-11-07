import { useState, type FormEvent } from 'react';
import { api, ApiError, type Settings } from '../api';

/**
 * Entrar com o celular: o código chega no WhatsApp. Primeira vez = cadastro.
 * `inline`: dentro de um cartão (ex.: antes de pedir orçamentos), sem a caixa de página.
 */
export function Login({
  onDone,
  inline = false,
  title = 'Entrar no Desenrola',
  intro = 'Teu celular é teu login. Te mando um código no WhatsApp, sem senha.',
  submitLabel = 'Entrar',
  askName = false,
}: {
  onDone: (me: Settings) => void;
  inline?: boolean;
  title?: string;
  intro?: string;
  submitLabel?: string;
  /** pede o nome junto (vai pro profissional quando o cliente aprovar) */
  askName?: boolean;
}) {
  const [name, setName] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const digits = phone.replace(/\D/g, '').replace(/^55/, '');

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

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let me = await api.verifyCode(phone, code, consent);
      if (askName && name.trim() && !me.user_name) me = await api.putSettings({ user_name: name.trim() });
      onDone(me);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não consegui entrar agora.');
    } finally {
      setBusy(false);
    }
  };

  const box = inline ? 'login-inline' : 'ob-box glass';
  const H = inline ? 'h3' : 'h1';
  const content = (
    <>
      {step === 'phone' ? (
        <form className={box} onSubmit={requestCode}>
          <H>{title}</H>
          <p>{intro}</p>
          {askName && (
            <>
              <label className="sr-only" htmlFor="login-name">
                Teu nome
              </label>
              <input id="login-name" className="ob-input" autoComplete="given-name" placeholder="Teu nome" value={name} onChange={(e) => setName(e.target.value)} />
            </>
          )}
          <label className="sr-only" htmlFor="login-phone">
            Celular com DDD
          </label>
          <input
            id="login-phone"
            className="ob-input"
            type="tel"
            autoFocus={!askName}
            autoComplete="tel-national"
            placeholder="Celular com DDD"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <label className="consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>Quero receber pelo WhatsApp os avisos dos meus pedidos (orçamentos e perguntas dos profissionais).</span>
          </label>
          {error && <p className="error-text">{error}</p>}
          <div className="ob-actions">
            <span />
            <button type="submit" className="btn dark" disabled={busy || digits.length < 10 || (askName && !name.trim())}>
              {busy ? 'Enviando…' : 'Receber código'}
            </button>
          </div>
        </form>
      ) : (
        <form className={box} onSubmit={verify}>
          <H>Digita o código</H>
          <p>Mandei um código de 6 números pro WhatsApp do {phone}.</p>
          {devCode && <p className="note">Modo de teste (sem Twilio): o código é {devCode}.</p>}
          <label className="sr-only" htmlFor="login-code">
            Código
          </label>
          <input
            id="login-code"
            className="ob-input code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          {error && <p className="error-text">{error}</p>}
          <div className="ob-actions">
            <button type="button" className="btn ghost" onClick={() => setStep('phone')}>
              Trocar número
            </button>
            <span style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" disabled={busy} onClick={() => void requestCode()}>
                Reenviar
              </button>
              <button type="submit" className="btn dark" disabled={busy || code.length !== 6}>
                {submitLabel}
              </button>
            </span>
          </div>
        </form>
      )}
    </>
  );
  return inline ? content : <section className="home">{content}</section>;
}
