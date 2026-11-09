import { useEffect, useState, type FormEvent } from 'react';
import { BrandMark } from '../App';
import { Admin } from './Admin';
import { adminApi, AdminApiError } from './adminApi';
import './admin.css';

/** Pede a senha do admin antes de mostrar o painel (sessão própria, separada do login dos clientes). */
export function AdminGate() {
  const [state, setState] = useState<'checking' | 'out' | 'in'>('checking');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const check = () =>
      adminApi.me().then(
        () => setState('in'),
        // servidor fora do ar (deploy) não é "sem login": tenta de novo em vez de pedir a senha
        (e) => {
          if (e instanceof AdminApiError && e.code === 'offline') {
            setOffline(true);
            timer = setTimeout(check, 3000);
          }
          else setState('out');
        },
      );
    void check();
    return () => clearTimeout(timer);
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
  if (state === 'checking') return <section className="gate">{offline && <p className="field-help">O servidor não respondeu. Pode ser uma atualização; tento de novo sozinho.</p>}</section>;
  return (
    <section className="gate">
      <form className="gate-box" onSubmit={submit}>
        <span className="adm-brand">
          <BrandMark size={26} />
          desenrola
        </span>
        <h1>Admin</h1>
        <label className="field" htmlFor="adm-pass">
          Senha
          <input id="adm-pass" className="ob-input" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button type="submit" className="abtn primary block" disabled={busy || !password}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </section>
  );
}
