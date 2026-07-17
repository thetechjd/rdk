import { useState } from 'react';
import type { VisibilityChoice } from '../shared/ipc';
import { LoginForm } from './LoginForm';

const STEPS = ['account', 'vault', 'plan', 'node', 'mcp'] as const;
type Step = typeof STEPS[number];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const [vaultPath, setVaultPath] = useState('');
  const [signedIn, setSignedIn] = useState(false);
  const [visibility, setVisibility] = useState<VisibilityChoice>('private');
  const [autoStart, setAutoStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const step: Step = STEPS[i];

  const canNext =
    step === 'account' ? true :
    step === 'vault' ? !!vaultPath :
    true;

  const chooseVault = async () => {
    const dir = await window.rdk.chooseVaultDirectory();
    if (dir) setVaultPath(dir);
  };

  const finish = async () => {
    setBusy(true);
    // Signing in (above) already persisted the account + node link; init just
    // establishes the local node config for the chosen vault.
    const r = await window.rdk.initNode({ vaultPath, visibility, autoStart });
    if (r.ok) {
      if (autoStart) await window.rdk.setAutoStart(true).catch(() => {});
      await window.rdk.reindex().catch(() => {});
      onDone();
    } else {
      setBusy(false);
      // eslint-disable-next-line no-alert
      window.alert(r.error ?? 'Setup failed');
    }
  };

  return (
    <div className="modal-overlay" style={{ background: 'var(--bg-deep)' }}>
      <div className="modal" style={{ width: 560 }}>
        <div className="modal-header">
          <span className="brand" style={{ color: 'var(--phosphor)', letterSpacing: '0.14em' }}>RDK</span>
          <span className="title">first-run setup</span>
        </div>
        <div className="modal-body">
          <div className="wizard-steps">
            {STEPS.map((s, idx) => (
              <div key={s} className={`wizard-step${idx < i ? ' done' : idx === i ? ' current' : ''}`} />
            ))}
          </div>

          {step === 'account' && (
            <>
              <div className="wizard-title">Sign in</div>
              <div className="hint">
                Sign in to your RetroDeck account to serve on the network and manage your plan.
                You can also skip this and run as a local-only node — sign in later from Settings → Account.
              </div>
              {signedIn
                ? <div className="hint" style={{ color: 'var(--phosphor)' }}>◆ signed in — continue below.</div>
                : <LoginForm onSuccess={() => setSignedIn(true)} />}
            </>
          )}

          {step === 'vault' && (
            <>
              <div className="wizard-title">Choose your vault</div>
              <div className="hint">Point RDK at your notes folder (your Obsidian vault works great).</div>
              <div className="field">
                <div className="row">
                  <input readOnly value={vaultPath} placeholder="no folder chosen" />
                  <button className="primary" onClick={chooseVault}>choose…</button>
                </div>
              </div>
            </>
          )}

          {step === 'plan' && (
            <>
              <div className="wizard-title">Plan & default visibility</div>
              <div className="hint">Free by default. New indexing will default to this visibility (you can change per-file later).</div>
              <div className="field">
                <label>default visibility</label>
                <div className="row">
                  <button className={visibility === 'private' ? 'primary' : ''} onClick={() => setVisibility('private')}>private</button>
                  <button className={visibility === 'public' ? 'cassette' : ''} onClick={() => setVisibility('public')}>public (earns tips)</button>
                </div>
              </div>
            </>
          )}

          {step === 'node' && (
            <>
              <div className="wizard-title">Start your node</div>
              <div className="hint">Your node serves your public knowledge to the network and keeps your index in sync.</div>
              <label className="row" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={autoStart} onChange={e => setAutoStart(e.target.checked)} style={{ width: 'auto' }} />
                <span>Start RDK automatically when I log in (recommended)</span>
              </label>
            </>
          )}

          {step === 'mcp' && (
            <>
              <div className="wizard-title">Connect Claude Desktop (optional)</div>
              <div className="hint">You can copy the MCP config snippet any time from Settings → MCP. Finish setup to start indexing your vault.</div>
            </>
          )}

          <div className="wizard-nav">
            <button className="ghost" disabled={i === 0 || busy} onClick={() => setI(i - 1)}>← back</button>
            {i < STEPS.length - 1
              ? <button className="primary" disabled={!canNext} onClick={() => setI(i + 1)}>next →</button>
              : <button className="primary" disabled={busy || !vaultPath} onClick={finish}>{busy ? 'setting up…' : 'finish & index'}</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
