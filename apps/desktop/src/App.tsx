import { useEffect, useState } from 'react';
import { AppProvider, useApp } from './store';
import { VaultTree } from './panes/VaultTree';
import { GraphView } from './panes/GraphView';
import { ContentPane } from './panes/ContentPane';
import { FileBrowser } from './panes/FileBrowser';
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
            {activeTab?.kind === 'folder' && activeTab.location && (
              <FileBrowser location={activeTab.location} title={activeTab.title} />
            )}
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
  const { status, openGraph, setPaletteOpen } = useApp();
  // "live" must mean retrievable, not merely static — a node that's running but
  // holds no connection to Central serves nothing.
  const live = status?.contentServing;
  const shortcut = navigator.platform.toLowerCase().includes('mac') ? '⌘K' : 'Ctrl K';
  return (
    <div className="titlebar">
      <span className="brand" onClick={openGraph} style={{ cursor: 'pointer' }}>RDK</span>
      <span className="spacer" />
      {/* Querying is the whole point of the product, and it lived behind an
          undiscoverable Cmd/Ctrl+K with no affordance anywhere in the UI. The
          button carries the shortcut so it teaches it rather than replacing it. */}
      <button className="query-trigger" onClick={() => setPaletteOpen(true)}
        title="Search your knowledge and the network">
        <span className="q-icon">⌕</span>
        <span className="q-label">query</span>
        <span className="q-key">{shortcut}</span>
      </button>
      <span className="spacer" />
      {/* "node idle" named the state and nothing else — no cause, no fix, and
          no hint that the app keeps trying on its own. When something really is
          blocking it (an expired session, no network yet), say that instead. */}
      <span className="node-pill item" style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        title={live
          ? 'Connected to the network — your indexed content can be retrieved.'
          : status?.notServingReason
            ?? 'Connecting to the network — your content cannot be retrieved until this succeeds.'}>
        <span className={`dot ${live ? 'public' : 'local'}`} />
        <span style={{ color: live ? 'var(--cassette)' : 'var(--muted)' }}>
          {live ? 'node live' : status?.notServingReason ? 'node blocked' : 'connecting…'}
        </span>
      </span>
    </div>
  );
}

function Tabs() {
  const { tabs, activeTabId, setActiveTab, closeTab, openEarnings, setSettingsOpen } = useApp();
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
      {/* Withdraw existed, but only inside an Earnings tab with no way to open
          it. Money controls must be visible navigation, not unreachable code. */}
      <div className="tab" onClick={openEarnings} title="Earnings and withdrawals">◎ earnings / withdraw</div>
      <div className="tab" onClick={() => setSettingsOpen(true)} title="Settings">⚙ settings</div>
    </div>
  );
}
