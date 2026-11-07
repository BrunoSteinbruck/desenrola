import { useState, type FormEvent } from 'react';
import { BrandMark } from '../App';

/* /profissional: o profissional se cadastra sozinho. 3 caixinhas: o que faz e onde → celular e aceite → código. */

const SERVICES = [
  'eletricista', 'encanador', 'chaveiro', 'pintor', 'pedreiro', 'marceneiro', 'montador de móveis',
  'técnico em ar-condicionado', 'técnico em máquina de lavar', 'técnico de eletrodomésticos', 'vidraceiro', 'jardineiro', 'diarista',
];

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/pro${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? 'Não consegui agora. Tenta de novo.');
  return data as T;
}

export function ProSignup() {
  const [step, setStep] = useState<'about' | 'phone' | 'code' | 'done'>('about');
  const [name, setName] = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [other, setOther] = useState('');
  const [city, setCity] = useState('Porto Alegre');
  const [hoods, setHoods] = useState('');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allServices = [...services, ...other.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)];
  const phoneOk = phone.replace(/\D/g, '').replace(/^55/, '').length >= 10;
  const toggle = (s: string) => setServices((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

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
    void run(async () => {
      const r = await post<{ dev_code?: string }>('/request-code', { phone });
      setDevCode(r.dev_code ?? null);
      setCode('');
      setStep('code');
    });
  };

  return (
    <div className="pro">
      <header className="pro-head">
        <a href="/" className="brand" style={{ textDecoration: 'none' }}>
          <BrandMark />
          desenrola
        </a>
        <span className="label-mono">Para profissionais</span>
      </header>
      <section className="home">
        {step === 'about' && (
          <form
            className="ob-box"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && allServices.length && city.trim()) setStep('phone');
            }}
          >
            <h1>Receba pedidos da tua região</h1>
            <p>Quando alguém perto de ti precisar do teu serviço, a gente te avisa no WhatsApp. Tu vê o pedido e passa o orçamento se quiser.</p>
            <label className="field">
              Teu nome ou da tua empresa
              <input className="ob-input" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
            </label>
            <fieldset className="pro-services">
              <legend>O que tu faz</legend>
              <div className="chips">
                {SERVICES.map((s) => (
                  <button key={s} type="button" className={`chip${services.includes(s) ? ' on' : ''}`} aria-pressed={services.includes(s)} onClick={() => toggle(s)}>
                    {s}
                  </button>
                ))}
              </div>
              <label className="sr-only" htmlFor="pro-other">
                Outro serviço
              </label>
              <input id="pro-other" className="ob-input" placeholder="Outro (separa por vírgula)" value={other} onChange={(e) => setOther(e.target.value)} />
            </fieldset>
            <div className="field-row">
              <label className="field">
                Cidade
                <input className="ob-input" value={city} onChange={(e) => setCity(e.target.value)} />
              </label>
              <label className="field">
                Bairros que atende
                <input className="ob-input" placeholder="Vazio = cidade toda" value={hoods} onChange={(e) => setHoods(e.target.value)} />
              </label>
            </div>
            <div className="ob-actions">
              <span />
              <button type="submit" className="btn dark" disabled={!name.trim() || !allServices.length || !city.trim()}>
                Continuar
              </button>
            </div>
          </form>
        )}

        {step === 'phone' && (
          <form className="ob-box" onSubmit={sendCode}>
            <h1>Teu WhatsApp</h1>
            <p>É por ele que chegam os pedidos. Te mando um código pra confirmar que o número é teu.</p>
            <label className="sr-only" htmlFor="pro-phone">
              Celular com DDD
            </label>
            <input id="pro-phone" className="ob-input" type="tel" autoFocus autoComplete="tel-national" placeholder="Celular com DDD" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <label className="consent">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>Quero receber pedidos de serviço do Desenrola pelo WhatsApp. Posso parar quando quiser mandando SAIR.</span>
            </label>
            {error && <p className="error-text">{error}</p>}
            <div className="ob-actions">
              <button type="button" className="btn ghost" onClick={() => setStep('about')}>
                Voltar
              </button>
              <button type="submit" className="btn dark" disabled={busy || !phoneOk || !consent}>
                {busy ? 'Enviando…' : 'Receber código'}
              </button>
            </div>
          </form>
        )}

        {step === 'code' && (
          <form
            className="ob-box"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await post('/register', { name, phone, code, consent, categories: allServices, city, neighborhoods: hoods });
                setStep('done');
              });
            }}
          >
            <h1>Digita o código</h1>
            <p>Mandei um código de 6 números pro WhatsApp do {phone}.</p>
            {devCode && <p className="note">Modo de teste (sem Twilio): o código é {devCode}.</p>}
            <label className="sr-only" htmlFor="pro-code">
              Código
            </label>
            <input
              id="pro-code"
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
                <button type="button" className="btn" disabled={busy} onClick={() => sendCode()}>
                  Reenviar
                </button>
                <button type="submit" className="btn dark" disabled={busy || code.length !== 6}>
                  {busy ? 'Cadastrando…' : 'Cadastrar'}
                </button>
              </span>
            </div>
          </form>
        )}

        {step === 'done' && (
          <div className="ob-box">
            <h1>Pronto, {name.split(/\s+/)[0]}!</h1>
            <p>
              Quando aparecer um pedido de {allServices.join(', ')} {hoods.trim() ? `em ${hoods}` : `em ${city}`}, te aviso no WhatsApp. Tu toca em "Ver
              detalhes" e passa o orçamento. Pra parar de receber, é só mandar SAIR.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
