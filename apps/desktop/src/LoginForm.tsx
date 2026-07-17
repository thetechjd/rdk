import { useState } from 'react';
import { useApp } from './store';

/**
 * Native RetroDeck sign-in. Credentials go straight from the main process to the
 * RetroDeck API (the same exchange `rdk account:login` performs) — no browser
 * round-trip, no token pasting. Tokens are stored in ~/.rdk/config.json, which the
 * CLI shares, so signing in here also re-authenticates `rdk`.
 */
export function LoginForm({ onSuccess }: { onSuccess?: () => void }) {
  const app = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim() || !password) { setError('Enter your email and password.'); return; }
    setBusy(true);
    setError(null);
    const r = await window.rdk.login(email.trim(), password);
    setBusy(false);
    if (!r.ok) { setError(r.error ?? 'Login failed'); return; }

    setPassword('');
    app.toast(r.linkStatus === 'linked' ? 'Signed in · node linked' : 'Signed in');
    if (r.linkStatus === 'failed') {
      app.toast(`Signed in, but linking this node failed (${r.linkReason ?? 'unknown'}) — your chunks may not show in the dashboard.`, true);
    }
    if (r.emailVerified === false) {
      app.toast('Verify your email to finish setting up your account.', true);
    }
    onSuccess?.();
  };

  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter') void submit(); };

  return (
    <div className="login-form">
      <div className="field">
        <label>email</label>
        <input
          type="email" value={email} autoComplete="username" placeholder="you@example.com"
          onChange={e => setEmail(e.target.value)} onKeyDown={onKey} disabled={busy}
        />
      </div>
      <div className="field">
        <label>password</label>
        <input
          type="password" value={password} autoComplete="current-password"
          onChange={e => setPassword(e.target.value)} onKeyDown={onKey} disabled={busy}
        />
      </div>
      {error && <div className="hint warn">{error}</div>}
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'signing in…' : 'sign in'}
        </button>
        <button className="ghost" disabled={busy} onClick={() => window.rdk.openSignup()}>create account →</button>
      </div>
    </div>
  );
}
