// src/store.tsx — app-wide UI state shared by every pane. Deliberately small:
// selection, open tabs, live node status, and a toast channel. All network/data
// access goes through window.rdk (the typed bridge), never here.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Account, NodeStatus, PlatformCapabilities, PushEvent } from '../shared/ipc';

export type TabKind = 'graph' | 'content' | 'earnings';
export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  chunkId?: string;
  filePath?: string;
}

interface ToastMsg { text: string; error?: boolean }

interface AppState {
  status: NodeStatus | null;
  account: Account | null;
  caps: PlatformCapabilities | null;

  tabs: Tab[];
  activeTabId: string;
  selectedChunkId: string | null;
  selectedFilePath: string | null;

  paletteOpen: boolean;
  settingsOpen: boolean;
  /** Bumped to force VaultTree/Graph reloads after indexing/publish/etc. */
  dataVersion: number;

  setActiveTab(id: string): void;
  openTab(tab: Tab): void;
  closeTab(id: string): void;
  openGraph(): void;
  openEarnings(): void;
  openContentForChunk(chunkId: string, title: string): void;
  openContentForFile(filePath: string, title: string): void;
  selectChunk(chunkId: string | null): void;
  selectFile(filePath: string | null): void;

  setPaletteOpen(v: boolean): void;
  setSettingsOpen(v: boolean): void;
  refreshData(): void;
  refreshStatus(): void;
  toast(text: string, error?: boolean): void;
  currentToast: ToastMsg | null;
}

const Ctx = createContext<AppState | null>(null);

const GRAPH_TAB: Tab = { id: 'graph', kind: 'graph', title: 'graph' };

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<NodeStatus | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [caps, setCaps] = useState<PlatformCapabilities | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([GRAPH_TAB]);
  const [activeTabId, setActiveTabId] = useState('graph');
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);
  const [currentToast, setCurrentToast] = useState<ToastMsg | null>(null);

  const refreshStatus = useCallback(() => { window.rdk.getStatus().then(setStatus).catch(() => {}); }, []);
  const refreshData = useCallback(() => setDataVersion(v => v + 1), []);
  const toast = useCallback((text: string, error?: boolean) => {
    setCurrentToast({ text, error });
    setTimeout(() => setCurrentToast(null), 3200);
  }, []);

  useEffect(() => {
    refreshStatus();
    window.rdk.getAccount().then(setAccount).catch(() => {});
    window.rdk.getCapabilities().then(setCaps).catch(() => {});
    const off = window.rdk.onPush((e: PushEvent) => {
      switch (e.type) {
        case 'status': setStatus(e.status); break;
        case 'vault-changed': setDataVersion(v => v + 1); break;
        case 'retrieval': setDataVersion(v => v + 1); break;
        case 'tip-earned': setDataVersion(v => v + 1); refreshStatus(); break;
        case 'sync-progress': if (e.message) setCurrentToast({ text: e.message }); break;
      }
    });
    return off;
  }, [refreshStatus]);

  const openTab = useCallback((tab: Tab) => {
    setTabs(prev => (prev.some(t => t.id === tab.id) ? prev : [...prev, tab]));
    setActiveTabId(tab.id);
  }, []);

  const closeTab = useCallback((id: string) => {
    if (id === 'graph') return; // graph tab is permanent
    setTabs(prev => prev.filter(t => t.id !== id));
    setActiveTabId(prev => (prev === id ? 'graph' : prev));
  }, []);

  const openGraph = useCallback(() => setActiveTabId('graph'), []);
  const openEarnings = useCallback(() => openTab({ id: 'earnings', kind: 'earnings', title: 'earnings' }), [openTab]);
  const openContentForChunk = useCallback((chunkId: string, title: string) =>
    openTab({ id: `c:${chunkId}`, kind: 'content', title, chunkId }), [openTab]);
  const openContentForFile = useCallback((filePath: string, title: string) =>
    openTab({ id: `f:${filePath}`, kind: 'content', title, filePath }), [openTab]);

  const value: AppState = useMemo(() => ({
    status, account, caps, tabs, activeTabId,
    selectedChunkId, selectedFilePath, paletteOpen, settingsOpen, dataVersion,
    setActiveTab: setActiveTabId, openTab, closeTab, openGraph, openEarnings,
    openContentForChunk, openContentForFile,
    selectChunk: setSelectedChunkId, selectFile: setSelectedFilePath,
    setPaletteOpen, setSettingsOpen, refreshData, refreshStatus, toast, currentToast,
  }), [status, account, caps, tabs, activeTabId, selectedChunkId, selectedFilePath,
    paletteOpen, settingsOpen, dataVersion, openTab, closeTab, openGraph, openEarnings,
    openContentForChunk, openContentForFile, refreshData, refreshStatus, toast, currentToast]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
