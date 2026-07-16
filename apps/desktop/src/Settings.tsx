import { useEffect, useState } from 'react';
import type { Account, McpInfo, NodeStatus, Preferences } from '../shared/ipc';
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
  useEffect(() => { window.rdk.getAccount().then(setAcct); }, []);

  return (
    <>
      <div className="field">
        <label>account</label>
        {acct?.signedIn ? (
          <div className="row">
            <span>{acct.email ?? acct.nodeId}</span>
            <button onClick={() => window.rdk.signOut().then(() => window.rdk.getAccount().then(setAcct))}>sign out</button>
          </div>
        ) : (
          <div className="row">
            <span style={{ color: 'var(--muted)' }}>not signed in</span>
            <button className="primary" onClick={() => window.rdk.signIn()}>sign in →</button>
          </div>
        )}
      </div>
      <div className="field">
        <label>plan</label>
        <div className="row">
          <span className="plan" style={{ color: 'var(--phosphor)' }}>{acct?.plan ?? 'free'}</span>
          <button onClick={() => window.rdk.openUpgrade()}>upgrade →</button>
        </div>
      </div>
      <div className="field">
        <label>balance</label>
        <div className="row">
          <span className="balance" style={{ color: 'var(--cassette)' }}>${(acct?.balanceUsdc ?? 0).toFixed(2)} USDC</span>
          <button onClick={() => window.rdk.openTopUp()}>top up →</button>
        </div>
        <div className="hint">Payments open in your browser.</div>
      </div>
    </>
  );
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
