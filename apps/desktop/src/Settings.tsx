import { useCallback, useEffect, useState } from 'react';
import type { Account, BillingInterval, McpInfo, NodeStatus, Plan, Preferences } from '../shared/ipc';
import { useApp } from './store';

type Section = 'node' | 'vault' | 'account' | 'mcp' | 'prefs';

export function Settings() {
  const app = useApp();
  const [section, setSection] = useState<Section>('node');

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) app.setSettingsOpen(false); }}>
      <div className="modal">
        <div className="modal-header">
          <span className="title">Settings</span>
          <button className="ghost" onClick={() => app.setSettingsOpen(false)}>close ×</button>
        </div>
        <div className="settings-tabs">
          {(['node', 'vault', 'account', 'mcp', 'prefs'] as Section[]).map(s => (
            <div key={s} className={`settings-tab${section === s ? ' active' : ''}`} onClick={() => setSection(s)}>{s}</div>
          ))}
        </div>
        <div className="modal-body">
          {section === 'node' && <NodeSection />}
          {section === 'vault' && <VaultSection />}
          {section === 'account' && <AccountSection />}
          {section === 'mcp' && <McpSection />}
          {section === 'prefs' && <PrefsSection />}
        </div>
      </div>
    </div>
  );
}

function useAction() {
  const app = useApp();
  return async (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => {
    const r = await fn();
    app.toast(r.ok ? ok : (r.error ?? 'Failed'), !r.ok);
    app.refreshStatus();
  };
}

function NodeSection() {
  const app = useApp();
  const act = useAction();
  const [status, setStatus] = useState<NodeStatus | null>(app.status);
  useEffect(() => { window.rdk.getStatus().then(setStatus); }, [app.dataVersion, app.status]);

  return (
    <>
      <div className="field">
        <label>node status</label>
        <div className="row">
          <span className={`dot ${status?.serving ? 'public' : 'local'}`} />
          <span>{status?.serving ? 'serving on the network' : 'not serving'}</span>
          <span style={{ color: 'var(--muted)' }}>· ws {status?.wsConnected ? 'connected' : 'disconnected'}</span>
        </div>
      </div>
      <div className="field">
        <div className="row">
          {status?.serving
            ? <button onClick={() => act(() => window.rdk.stopNode(), 'Node stopped')}>stop node</button>
            : <button className="primary" onClick={() => act(() => window.rdk.startNode(), 'Node started')}>start node</button>}
          <button onClick={() => act(() => window.rdk.forceSync(), 'Synced')}>force sync</button>
        </div>
      </div>
      <div className="field">
        <label>auto-start on boot</label>
        <div className="row">
          <button disabled={!app.caps?.autoStart} title={app.caps?.autoStart ? '' : 'Not supported on this platform — use a service instead'}
            onClick={() => act(() => window.rdk.setAutoStart(true), 'Auto-start enabled')}>enable auto-start</button>
          <button disabled={!app.caps?.serviceInstall} title={app.caps?.serviceInstall ? '' : 'Not supported on this platform yet'}
            onClick={() => act(() => window.rdk.installService(), 'Service installed')}>install as service</button>
        </div>
        {!app.caps?.autoStart && <div className="hint">Auto-start on this platform ({app.caps?.platform}) uses a background service instead of a login item.</div>}
      </div>
    </>
  );
}

function VaultSection() {
  const app = useApp();
  const act = useAction();
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  useEffect(() => { window.rdk.getPreferences().then(setPrefs); }, []);

  const changeVault = async () => {
    const dir = await window.rdk.chooseVaultDirectory();
    if (!dir) return;
    await window.rdk.setPreferences({ vaultPath: dir });
    setPrefs(await window.rdk.getPreferences());
    app.refreshData();
    app.toast('Vault directory updated');
  };

  return (
    <>
      <div className="field">
        <label>vault directory</label>
        <div className="row">
          <input readOnly value={prefs?.vaultPath ?? ''} />
          <button onClick={changeVault}>change…</button>
        </div>
      </div>
      <div className="field">
        <label>maintenance</label>
        <div className="row">
          <button onClick={() => act(() => window.rdk.reindex(), 'Re-indexed vault')}>re-index vault</button>
          <button onClick={() => act(() => window.rdk.forceSync(), 'Synced')}>force sync</button>
        </div>
      </div>
    </>
  );
}

function AccountSection() {
  const app = useApp();
  const [acct, setAcct] = useState<Account | null>(app.account);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('monthly');
  const [amount, setAmount] = useState('10');
  const [busy, setBusy] = useState<string | null>(null);
  // Set after a browser checkout handoff; drives the verify poll (verifying is
  // what actually credits a top-up — there's no async webhook).
  const [awaiting, setAwaiting] = useState<{ kind: 'subscription' | 'topup'; paymentId?: string } | null>(null);

  const refresh = useCallback(async () => setAcct(await window.rdk.getAccount()), []);
  useEffect(() => { void refresh(); }, [refresh]);

  const checkNow = useCallback(async (): Promise<boolean> => {
    if (!awaiting) return false;
    if (awaiting.kind === 'subscription') {
      const r = await window.rdk.verifySubscription();
      if (r.paid) { app.toast(`${r.planName ?? r.planId ?? 'Plan'} activated`); setAwaiting(null); void refresh(); return true; }
    } else {
      const r = await window.rdk.verifyTopup(awaiting.paymentId);
      if (r.completed) { app.toast(`Credited — balance $${(r.balanceUsdc ?? 0).toFixed(2)}`); setAwaiting(null); void refresh(); return true; }
    }
    return false;
  }, [awaiting, app, refresh]);

  // Poll for ~60s after the handoff, then stop and let the user re-check.
  useEffect(() => {
    if (!awaiting) return;
    let alive = true, tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!alive) return;
      if (await checkNow()) return;
      if (++tries >= 24) { setAwaiting(null); app.toast('Not confirmed yet — it can take a moment to settle.', true); return; }
      if (alive) timer = setTimeout(() => void tick(), 2500);
    };
    timer = setTimeout(() => void tick(), 2500);
    return () => { alive = false; clearTimeout(timer); };
  }, [awaiting, checkNow, app]);

  const openPicker = async () => {
    setPicking(true);
    if (plans) return;
    const r = await window.rdk.getPlans();
    if (r.ok) setPlans(r.plans ?? []);
    else app.toast(r.error ?? 'Could not load plans', true);
  };

  const changePlan = async (plan: Plan) => {
    setBusy('plan');
    const r = await window.rdk.selectPlan(plan.id, plan.priceMonthly > 0 ? billingInterval : undefined);
    setBusy(null);
    if (!r.ok) { app.toast(r.error ?? 'Plan change failed', true); return; }
    setPicking(false);
    if (r.checkoutUrl) { app.toast('Finish checkout in your browser…'); setAwaiting({ kind: 'subscription' }); }
    else { app.toast(`Switched to ${plan.name}`); void refresh(); }
  };

  const topUp = async () => {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) { app.toast('Enter a valid amount', true); return; }
    setBusy('topup');
    const r = await window.rdk.createTopup(amt);
    setBusy(null);
    if (!r.ok) { app.toast(r.error ?? 'Could not start top-up', true); return; }
    app.toast('Finish payment in your browser…');
    setAwaiting({ kind: 'topup', paymentId: r.paymentId });
  };

  const balance = acct?.balanceUsdc;
  const withdrawable = balance != null ? Math.max(0, balance - (acct?.creditLimitUsd ?? 0)) : null;

  return (
    <>
      {acct?.sessionExpired && (
        <div className="hint warn">Your RetroDeck session expired — sign in again to manage billing.</div>
      )}

      <div className="field">
        <label>account</label>
        {acct?.signedIn ? (
          <div className="row">
            <span>{acct.email ?? acct.nodeId}</span>
            <button onClick={() => window.rdk.signOut().then(() => void refresh())}>sign out</button>
          </div>
        ) : (
          <div className="row">
            <span style={{ color: 'var(--muted)' }}>not signed in</span>
            <button className="primary" onClick={() => window.rdk.signIn()}>sign in →</button>
          </div>
        )}
      </div>

      {awaiting && (
        <div className="field">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="hint"><span className="spin">◴</span> waiting for {awaiting.kind === 'topup' ? 'payment' : 'checkout'} to complete…</span>
            <span className="row" style={{ gap: 6 }}>
              <button onClick={() => void checkNow()}>check now</button>
              <button className="ghost" onClick={() => setAwaiting(null)}>cancel</button>
            </span>
          </div>
        </div>
      )}

      <div className="field">
        <label>plan</label>
        <div className="row">
          <span className="plan" style={{ color: 'var(--phosphor)' }}>{acct?.plan ?? 'free'}</span>
          {!picking
            ? <button disabled={!acct?.signedIn} onClick={() => void openPicker()}>change plan</button>
            : <button className="ghost" onClick={() => setPicking(false)}>close</button>}
        </div>

        {picking && (
          <div className="plan-picker">
            {!plans && <div className="hint">loading plans…</div>}
            {plans?.length === 0 && <div className="hint">No plans available.</div>}
            {plans && plans.length > 0 && (
              <>
                <div className="row" style={{ gap: 6, marginBottom: 8 }}>
                  <span className="hint">billing:</span>
                  <button className={billingInterval === 'monthly' ? 'primary' : ''} onClick={() => setBillingInterval('monthly')}>monthly</button>
                  <button className={billingInterval === 'yearly' ? 'primary' : ''} onClick={() => setBillingInterval('yearly')}>yearly</button>
                  <span className="hint">save ~17%</span>
                </div>
                {plans.map(p => (
                  <button
                    key={p.id}
                    className="plan-row"
                    disabled={busy === 'plan' || p.id === acct?.plan}
                    onClick={() => void changePlan(p)}
                  >
                    <span className="pr-name">{p.name}{p.id === acct?.plan && <span className="hint"> — current</span>}</span>
                    <span className="pr-meta">
                      {p.priceMonthly === 0 ? 'Free' : `$${p.priceMonthly}/mo`}
                      <span className="hint"> · {fmtNum(p.maxQueriesDay)} queries/day · {fmtNum(p.maxChunks)} chunks</span>
                    </span>
                  </button>
                ))}
                <div className="hint">Paid plans open a secure web checkout (card or crypto). RDK never handles your payment details.</div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="field">
        <label>balance</label>
        <div className="row">
          <span className="balance" style={{ color: 'var(--cassette)' }}>
            {balance != null ? `$${balance.toFixed(2)} USDC` : '—'}
          </span>
          {withdrawable != null && withdrawable !== balance && (
            <span className="hint">${withdrawable.toFixed(2)} withdrawable</span>
          )}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <span className="hint">$</span>
          <input
            style={{ width: 90 }}
            value={amount}
            onChange={e => setAmount(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void topUp(); }}
            disabled={!acct?.signedIn}
          />
          <button className="cassette" disabled={!acct?.signedIn || busy === 'topup'} onClick={() => void topUp()}>
            {busy === 'topup' ? 'opening…' : 'top up →'}
          </button>
          <button className="ghost" onClick={() => window.rdk.openTopUp()}>dashboard →</button>
        </div>
        <div className="hint">Top-up opens a browser checkout; your balance is credited once it's confirmed.</div>
      </div>
    </>
  );
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

function McpSection() {
  const app = useApp();
  const [info, setInfo] = useState<McpInfo | null>(null);
  useEffect(() => { window.rdk.getMcpInfo().then(setInfo); }, []);

  return (
    <>
      <div className="field">
        <label>claude desktop config</label>
        <div className="snippet-box">{info?.configSnippet}</div>
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={() => { navigator.clipboard.writeText(info?.configSnippet ?? ''); app.toast('Copied'); }}>copy snippet</button>
        </div>
        <div className="hint">Add this to your Claude Desktop config to expose your node's tools.</div>
      </div>
      <div className="field">
        <label>connected hosts</label>
        <div>{info?.connectedHosts.length ? info.connectedHosts.join(', ') : <span className="hint">none detected</span>}</div>
      </div>
    </>
  );
}

function PrefsSection() {
  const app = useApp();
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  useEffect(() => { window.rdk.getPreferences().then(setPrefs); }, []);

  const setVis = async (v: 'private' | 'public') => {
    const p = await window.rdk.setPreferences({ defaultVisibility: v });
    setPrefs(p);
    app.toast(`Default visibility: ${v}`);
  };

  return (
    <div className="field">
      <label>default index visibility</label>
      <div className="row">
        <button className={prefs?.defaultVisibility === 'private' ? 'primary' : ''} onClick={() => setVis('private')}>private</button>
        <button className={prefs?.defaultVisibility === 'public' ? 'cassette' : ''} onClick={() => setVis('public')}>public</button>
      </div>
      <div className="hint">New drag-and-drop indexing defaults to this visibility.</div>
    </div>
  );
}
