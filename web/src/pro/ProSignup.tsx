import { useState, type FormEvent } from 'react';
import { BrandMark } from '../App';
import { CodeInput, CoverageFields, coverageOk, MultiSelect, PhoneInput, phoneOk, type Coverage } from '../components/fields';
import { IconCheck } from '../components/ui';
import { SERVICES } from '../lib/options';

/* /profissional: o profissional se cadastra sozinho. Uma tela com tudo → código → pronto. */

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/pro${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('Não consegui agora. Tenta de novo.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? 'Não consegui agora. Tenta de novo.');
  return data as T;
}

export function ProSignup() {
  const [step, setStep] = useState<'form' | 'code' | 'done'>('form');
  const [name, setName] = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [coverage, setCoverage] = useState<Coverage>({ city: 'Porto Alegre', neighborhoods: null });
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = !!name.trim() && services.length > 0 && coverageOk(coverage) && phoneOk(phone) && consent;

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sendCode = (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    void run(async () => {
      const r = await post<{ dev_code?: string }>('/request-code', { phone });
      setDevCode(r.dev_code ?? null);
      setCode('');
      setStep('code');
    });
  };

  const register = (value: string) => {
    if (value.length !== 6) return;
    void run(async () => {
      try {
        await post('/register', { name, phone, code: value, consent, categories: services, city: coverage.city, neighborhoods: coverage.neighborhoods ?? [] });
        setStep('done');
      } catch (e) {
        setCode('');
        throw e;
      }
    });
  };

  const where = coverage.neighborhoods?.length ? coverage.neighborhoods.join(', ') : coverage.city;

  return (
    <div className="pro">
      <header className="pro-head">
        <a href="/" className="brand" style={{ textDecoration: 'none' }}>
          <BrandMark />
          desenrola
        </a>
        <span className="field-help">Para profissionais</span>
      </header>
      <section className="home">
        {step === 'form' && (
          <form className="ob-box" onSubmit={sendCode}>
            <h1>Receba pedidos da tua região</h1>
            <label className="field" htmlFor="pro-name">
              Teu nome ou da tua empresa
              <input id="pro-name" className="ob-input" value={name} autoFocus autoComplete="organization" onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="field">
              <label htmlFor="pro-services">O que tu faz</label>
              <MultiSelect id="pro-services" allowAdd lowercase value={services} options={SERVICES} placeholder="Selecionar serviços" searchPlaceholder="Buscar serviço" onChange={setServices} />
            </div>
            <CoverageFields idPrefix="pro" value={coverage} onChange={setCoverage} />
            <label className="field" htmlFor="pro-phone">
              Celular com WhatsApp
              <PhoneInput id="pro-phone" value={phone} onChange={setPhone} />
              <span className="field-help">É por ele que chegam os pedidos. Te mando um código pra confirmar.</span>
            </label>
            <label className="consent">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>Quero receber pedidos de serviço do Desenrola pelo WhatsApp.</span>
            </label>
            {error && <p className="error-text">{error}</p>}
            <button type="submit" className="btn dark ob-submit" disabled={busy || !ready}>
              {busy ? 'Enviando…' : 'Receber código'}
            </button>
          </form>
        )}

        {step === 'code' && (
          <form
            className="ob-box"
            onSubmit={(e) => {
              e.preventDefault();
              register(code);
            }}
          >
            <h1>Digita o código</h1>
            <p>Mandei 6 números pro WhatsApp do {phone}.</p>
            {devCode && <p className="note">Modo de teste (sem Twilio): o código é {devCode}.</p>}
            <label className="sr-only" htmlFor="pro-code">
              Código
            </label>
            <CodeInput id="pro-code" value={code} onChange={setCode} onComplete={register} />
            {error && <p className="error-text">{error}</p>}
            <button type="submit" className="btn dark ob-submit" disabled={busy || code.length !== 6}>
              {busy ? 'Cadastrando…' : 'Cadastrar'}
            </button>
            <div className="ob-links">
              <button type="button" className="link-btn" onClick={() => setStep('form')}>
                Corrigir dados
              </button>
              <button type="button" className="link-btn" disabled={busy} onClick={() => sendCode()}>
                Mandar de novo
              </button>
            </div>
          </form>
        )}

        {step === 'done' && (
          <div className="ob-box pro-done">
            <span className="pro-check">
              <IconCheck />
            </span>
            <h1>Pronto, {name.trim().split(/\s+/)[0]}!</h1>
            <p>
              Quando aparecer um pedido de {services.join(', ')} em {where}, te aviso no WhatsApp. Pra parar de receber, é só mandar SAIR.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
