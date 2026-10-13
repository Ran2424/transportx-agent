import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { App } from './App';
import { startBrowserApplication } from './composition-root';
import { BrandMark } from '../components/BrandMark';
import { Button } from '../components/ui/button';

type LoginState = { enabled: boolean; username: string | null };

export function WebAuthGate() {
  const { t } = useTranslation();
  const [state, setState] = useState<LoginState | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void fetch('/api/auth/session', { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error();
      const next = await response.json() as LoginState;
      if (!active) return;
      if (!next.enabled || next.username) startBrowserApplication();
      setState(next);
    }).catch(() => { if (active) setError(t('login.unavailable')); });
    return () => { active = false; };
  }, [t]);
  useEffect(() => {
    if (!state?.enabled || !state.username) return;
    const check = () => { void fetch('/api/auth/session', { cache: 'no-store' }).then(r => r.json()).then((next: LoginState) => { if (!next.username) window.location.reload(); }).catch(() => {}); };
    const timer = window.setInterval(check, 60_000);
    window.addEventListener('focus', check);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', check); };
  }, [state]);
  async function login(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username.trim(), password }) });
      if (!response.ok) { setError(t(response.status === 429 ? 'login.tooMany' : response.status === 401 ? 'login.invalid' : 'login.unavailable')); return; }
      window.location.reload();
    } catch { setError(t('login.unavailable')); }
    finally { setPassword(''); setBusy(false); }
  }
  async function logout() {
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error();
      window.location.reload();
    } catch { window.alert(t('login.unavailable')); }
  }
  if (state && (!state.enabled || state.username)) return <App webUsername={state.enabled ? state.username || undefined : undefined} onLogout={() => void logout()} />;
  return <main className="web-login"><section className="web-login-card" aria-labelledby="web-login-title">
    <div className="web-login-brand"><BrandMark /><span>TransportX <small>AGENT</small></span></div>
    <h1 id="web-login-title">{t('login.title')}</h1><p>{t('login.description')}</p>
    {!state ? <div role="status">{error || t('login.checking')}{error ? <Button onClick={() => window.location.reload()}>{t('login.retry')}</Button> : null}</div> : <form onSubmit={event => void login(event)}>
      <label htmlFor="web-username">{t('login.username')}</label>
      <input id="web-username" autoComplete="username" maxLength={64} required value={username} onChange={event => setUsername(event.target.value)} />
      <label htmlFor="web-password">{t('login.password')}</label>
      <input id="web-password" type="password" autoComplete="current-password" maxLength={256} required value={password} onChange={event => setPassword(event.target.value)} />
      {error ? <div className="web-login-error" role="alert">{error}</div> : null}
      <Button type="submit" disabled={busy}>{t(busy ? 'login.signingIn' : 'login.signIn')}</Button>
      <small>{t('login.persistence')}</small>
    </form>}
  </section></main>;
}
