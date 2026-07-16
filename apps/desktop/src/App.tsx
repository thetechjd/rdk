import { useEffect, useState } from 'react';
import { AppProvider, useApp } from './store';
import { VaultTree } from './panes/VaultTree';
import { GraphView } from './panes/GraphView';
import { ContentPane } from './panes/ContentPane';
import { Inspector } from './panes/Inspector';
import { Earnings } from './panes/Earnings';
import { QueryBar } from './QueryBar';
import { Settings } from './Settings';
import { Onboarding } from './Onboarding';
import { StatusBar } from './StatusBar';

export function App() {
  const [initialized, setInitialized] = useState<boolean | null>(null);

  useEffect(() => { window.rdk.isInitialized().then(setInitialized); }, []);

  if (initialized === null) {
    return <div className="center-full" style={{ color: 'var(--phosphor)' }}>booting…</div>;
  }

  return (
    <AppProvider>
      {initialized ? <Shell /> : <Onboarding onDone={() => setInitialized(true)} />}
    </AppProvider>
  );
}

function Shell() {
  const app = useApp();

  // Cmd/Ctrl+K → query palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        app.setPaletteOpen(true);
      }
      if (e.key === 'Escape') { app.setPaletteOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [app]);

  const activeTab = app.tabs.find(t => t.id === app.activeTabId) ?? app.tabs[0];

  return (
    <div className="app">
      <Titlebar />
      <div className="workspace">
        <div className="pane left"><VaultTree /></div>
        <div className="pane center">
          <Tabs />
          <div className="pane-body" style={{ position: 'relative' }}>
            {/* Graph stays mounted so its physics/layout survive tab switches. */}
            <div style={{ display: activeTab?.kind === 'graph' ? 'block' : 'none', height: '100%' }}>
              <GraphView />
            </div>
            {activeTab?.kind === 'content' && <ContentPane tab={activeTab} />}
            {activeTab?.kind === 'earnings' && <Earnings />}
          </div>
        </div>
        <div className="pane right"><Inspector /></div>
      </div>
      <StatusBar />

      {app.paletteOpen && <QueryBar />}
      {app.settingsOpen && <Settings />}
      {app.currentToast && (
        <div className={`toast${app.currentToast.error ? ' error' : ''}`}>{app.currentToast.text}</div>
      )}
    </div>
  );
}

function Titlebar() {
  const { status, openGraph } = useApp();
  const serving = status?.serving;
  return (
    <div className="titlebar">
      <span className="brand" onClick={openGraph} style={{ cursor: 'pointer' }}>RDK</span>
      <span className="vault-name">{/* filled by StatusBar's vault name via tree */}</span>
      <span className="spacer" />
      <span className="node-pill item" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className={`dot ${serving ? 'public' : 'local'}`} />
        <span style={{ color: serving ? 'var(--cassette)' : 'var(--muted)' }}>
          {serving ? 'node live' : 'node idle'}
        </span>
      </span>
    </div>
  );
}

function Tabs() {
  const { tabs, activeTabId, setActiveTab, closeTab, setSettingsOpen } = useApp();
  return (
    <div className="tabs">
      {tabs.map(t => (
        <div key={t.id} className={`tab${t.id === activeTabId ? ' active' : ''}`} onClick={() => setActiveTab(t.id)}>
          <span>{t.title}</span>
          {t.id !== 'graph' && (
            <span className="close" onClick={e => { e.stopPropagation(); closeTab(t.id); }}>×</span>
          )}
        </div>
      ))}
      <div className="spacer" style={{ flex: 1 }} />
      <div className="tab" onClick={() => setSettingsOpen(true)} title="Settings">⚙ settings</div>
    </div>
  );
}
