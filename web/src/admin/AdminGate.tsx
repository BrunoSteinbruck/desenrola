import { useEffect, useState, type FormEvent } from 'react';
import { Admin } from './Admin';
import { adminApi } from './adminApi';
import './admin.css';

/** Pede a senha do admin antes de mostrar o painel (sessão própria, separada do login dos clientes). */
export function AdminGate() {
  const [state, setState] = useState<'checking' | 'out' | 'in'>('checking');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminApi.me().then(
      () => setState('in'),
      () => setState('out'),
    );
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi.login(password);
      setState('in');
    } catch {
      setError('Senha errada.');
    } finally {
      setBusy(false);
    }
  };

  if (state === 'in') return <Admin />;
  return (
    <>
      <div className="backdrop" aria-hidden="true">
        <span className="b1" />
        <span className="b2" />
        <span className="b3" />
      </div>
      <section className="home">
        {state === 'out' && (
          <form className="ob-box glass" onSubmit={submit}>
            <h1>Admin do Desenrola</h1>
            <label className="sr-only" htmlFor="adm-pass">
              Senha
            </label>
            <input id="adm-pass" className="ob-input" type="password" autoFocus autoComplete="current-password" placeholder="Senha" value={password} onChange={(e) => setPassword(e.target.value)} />
            {error && <p className="error-text">{error}</p>}
            <div className="ob-actions">
              <a className="btn ghost" href="/">
                Voltar pro site
              </a>
              <button type="submit" className="btn dark" disabled={busy || !password}>
                Entrar
              </button>
            </div>
          </form>
        )}
      </section>
    </>
  );
}
