// electron/main.ts
// Owns the BrowserWindow + every ipcMain handler. The renderer is pure UI behind
// contextIsolation; nodeIntegration is OFF. Handlers delegate to NodeService (the
// seam) and to a few Electron-native affordances (dialog, shell, login items).

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { NodeService } from './node-service';
import { PUSH_CHANNEL, type PushEvent, type RdkChannel } from '../shared/ipc';
import {
  autoStartSupported, setAutoStart, revealInFileManager, autoStartLabel,
} from './platform';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env.ELECTRON_RENDERER_URL;

// RetroDeck cartridge icon for the running window (Linux/Windows taskbar; macOS
// uses the app bundle). The build copies build/icon.png → out/icon.png, so it's
// bundled in the asar for the packaged app and present in dev too. Best-effort:
// only applied when the file resolves.
const ICON_CANDIDATE = app.isPackaged
  ? path.join(__dirname, '../icon.png')          // out/icon.png (inside asar)
  : path.join(__dirname, '../../build/icon.png'); // dev
const APP_ICON = fs.existsSync(ICON_CANDIDATE) ? ICON_CANDIDATE : undefined;

// Bundled embedding model (Xenova/all-MiniLM-L6-v2, ~23MB). A VENDORED repo asset at
// apps/desktop/build/models — no build-time or runtime fetch. Packaged builds ship it via
// electron-builder `extraResources` (<app>/resources/models); dev loads it straight from
// the source tree. When present, @rdk/core loads it locally and never hits the network;
// when absent (e.g. the plain CLI), it falls back to downloading.
const MODELS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'models')   // resources/models (outside asar)
  : path.join(__dirname, '../../build/models');  // dev
if (fs.existsSync(path.join(MODELS_DIR, 'Xenova'))) {
  process.env.RDK_MODELS_DIR = MODELS_DIR;
}

const service = new NodeService();
let mainWindow: BrowserWindow | null = null;
let vaultWatcher: fs.FSWatcher | null = null;
let statusTimer: NodeJS.Timeout | null = null;
let servingTimer: NodeJS.Timeout | null = null;

function push(event: PushEvent): void {
  mainWindow?.webContents.send(PUSH_CHANNEL, event);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: APP_ICON,
    backgroundColor: '#080A08',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload is ESM; contextIsolation + no nodeIntegration keeps the renderer locked down
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // External links open in the OS browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL!);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC registry ──────────────────────────────────────────────────────────────
// One entry per RdkChannel. Most delegate straight to the service; a handful use
// Electron-native APIs (dialog/shell/login items).

function registerHandlers(): void {
  const handlers: Record<RdkChannel, (...args: never[]) => unknown> = {
    // setup
    isInitialized: () => service.isInitialized(),
    getCapabilities: () => service.getCapabilities(),
    chooseVaultDirectory: async () => {
      const res = await dialog.showOpenDialog(mainWindow!, {
        title: 'Choose your vault folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
    },
    initNode: async (opts: never) => {
      try {
        await service.initNode(opts);
        startWatchers();
        beginServingLoop();
        return { ok: true };
      }
      catch (e) { return { ok: false, error: (e as Error).message }; }
    },
    // vault
    getVaultTree: () => service.getVaultTree(),
    getIndexedDocuments: () => service.getIndexedDocuments(),
    indexPaths: async (paths: never, visibility: never) => {
      push({ type: 'sync-progress', done: 0, total: 1, message: 'Indexing and syncing…' });
      const result = await service.indexPaths(paths, visibility);
      push({
        type: 'sync-progress',
        done: 1,
        total: 1,
        message: result.error ? 'Indexing or sync failed' : `Indexed and synced ${result.indexed} chunk(s)`,
      });
      push({ type: 'status', status: service.getStatus() });
      push({ type: 'vault-changed' });
      return result;
    },
    reindex: () => service.reindex(),
    setFolderPublic: (relPath: never, isPublic: never) => {
      service.setFolderPublic(relPath, isPublic);
      return { ok: true };
    },
    revealInFileManager: (p: never) => { revealInFileManager(p); },
    // chunk
    getChunk: (id: never) => service.getChunk(id),
    readContent: (id: never) => service.readContent(id),
    readFile: (p: never) => service.readFile(p),
    writeFile: (p: never, content: never) => service.writeFile(p, content),
    createFile: (parentRelPath: never, name: never) => service.createFile(parentRelPath, name),
    publishChunk: (id: never) => service.publishChunk(id),
    unpublishChunk: (id: never) => service.unpublishChunk(id),
    pinDocument: (documentHash: never, pinned: never) => service.pinDocument(documentHash, pinned),
    pinnedDocuments: (documentHashes: never) => service.pinnedDocuments(documentHashes),
    deleteChunk: (id: never) => service.deleteChunk(id),
    getRetrievedFor: (id: never) => service.getRetrievedFor(id),
    getVersions: (sourcePath: never) => service.getVersions(sourcePath),
    // graph + query
    getGraphData: () => service.getGraphData(),
    query: (q: never) => service.query(q),
    retrieveQueryDocument: (q: never, chunkId: never) => service.retrieveQueryDocument(q, chunkId),
    // lifecycle
    getStatus: () => service.getStatus(),
    startNode: async () => { const r = await service.startNode(); push({ type: 'status', status: service.getStatus() }); return r; },
    stopNode: async () => { const r = await service.stopNode(); push({ type: 'status', status: service.getStatus() }); return r; },
    forceSync: async () => {
      push({ type: 'sync-progress', done: 0, total: 1, message: 'Syncing…' });
      const r = await service.forceSync();
      push({ type: 'sync-progress', done: 1, total: 1, message: r.ok ? 'Synced' : 'Sync failed' });
      push({ type: 'status', status: service.getStatus() });
      return r;
    },
    installService: () => service.installService(),
    uninstallService: () => service.uninstallService(),
    setAutoStart: (enabled: never) => {
      if (!autoStartSupported()) return { ok: false, error: autoStartLabel() };
      try { setAutoStart(enabled); return { ok: true }; }
      catch (e) { return { ok: false, error: (e as Error).message }; }
    },
    // account / earnings / mcp / prefs
    getAccount: () => service.getAccount(),
    // Native login — no browser round-trip. Tokens land in ~/.rdk/config.json
    // (shared with the CLI), so signing in here also re-authenticates `rdk`.
    login: (email: never, password: never) => service.login(email, password),
    signOut: () => service.signOut(),
    // Account creation / password reset still belong on the web.
    openSignup: async () => { await shell.openExternal(`${service.getDashboardUrl()}/signup`); },
    openUpgrade: async () => { await shell.openExternal(`${service.getDashboardUrl()}/billing`); },
    // The server supplies the pay URL so all surfaces agree, but the renderer is
    // not trusted to name an arbitrary destination: anything off the dashboard
    // origin falls back to the known billing page.
    openBillingPortal: async (url: never) => {
      const fallback = `${service.getDashboardUrl()}/billing`;
      let target = fallback;
      try {
        const candidate = new URL(String(url ?? ''));
        const dashboard = new URL(service.getDashboardUrl());
        if (candidate.protocol === 'https:' && candidate.origin === dashboard.origin) {
          target = candidate.toString();
        }
      } catch { /* unparseable → fallback */ }
      await shell.openExternal(target);
    },
    openTopUp: async () => { await shell.openExternal(`${service.getDashboardUrl()}/balance`); },
    getEarnings: () => service.getEarnings(),
    // Billing (RetroDeck API). selectPlan/createTopup open the web checkout
    // themselves; the renderer then polls verifySubscription/verifyTopup.
    getPlans: () => service.getPlans(),
    selectPlan: (planId: never, interval: never, method: never) => service.selectPlan(planId, interval, method),
    verifySubscription: () => service.verifySubscription(),
    createTopup: (amountUsd: never, method: never) => service.createTopup(amountUsd, method),
    verifyTopup: (paymentRef: never) => service.verifyTopup(paymentRef),
    getWithdrawalStatus: () => service.getWithdrawalStatus(),
    getWallets: () => service.getWallets(),
    requestWithdrawal: async (amountUsdc: never, walletAddress: never, walletChain: never) => {
      const r = await service.requestWithdrawal(amountUsdc, walletAddress, walletChain);
      // The balance changed the moment this was accepted — refresh so the UI
      // never shows a figure the server has already moved on from.
      push({ type: 'status', status: service.getStatus() });
      return r;
    },
    getWithdrawals: () => service.getWithdrawals(),
    getMcpInfo: () => service.getMcpInfo(),
    getPreferences: () => service.getPreferences(),
    setPreferences: (prefs: never) => service.setPreferences(prefs),
    openExternal: (url: never) => { shell.openExternal(url); },
  };

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_e, ...args) => (fn as (...a: unknown[]) => unknown)(...args));
  }
}

// Light live updates: watch the vault for new files, and heartbeat status.
function startWatchers(): void {
  stopWatchers();
  const tree = service.getVaultTree();
  if (tree.root && fs.existsSync(tree.root)) {
    try {
      vaultWatcher = fs.watch(tree.root, { recursive: true }, () => push({ type: 'vault-changed' }));
    } catch {
      // recursive watch unsupported on some Linux kernels — degrade silently
    }
  }
  statusTimer = setInterval(() => push({ type: 'status', status: service.getStatus() }), 10_000);
}

function stopWatchers(): void {
  vaultWatcher?.close();
  vaultWatcher = null;
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
}

/** The app being open is the node being live. Start this both for an existing
 * install and immediately after first-run setup; previously it was created only
 * in app.whenReady(), when onboarding had not written a config yet. */
function beginServingLoop(): void {
  if (servingTimer) return;
  const keepServing = async (): Promise<void> => {
    const result = await service.ensureServing();
    if (result.ok) await service.forceSync().catch(() => undefined);
    push({ type: 'status', status: service.getStatus() });
    push({ type: 'vault-changed' });
  };
  void keepServing();
  servingTimer = setInterval(() => { void keepServing(); }, 60_000);
  servingTimer.unref?.();
}

app.whenReady().then(() => {
  registerHandlers();
  createWindow();
  if (service.isInitialized()) {
    startWatchers();
    beginServingLoop();
  }

  // Update check (throttled to once/day): prompt → confirm → download → installer
  // hand-off. Delayed so it never competes with startup; packaged builds only.
  setTimeout(() => {
    void import('./updater').then(({ checkForUpdates }) => checkForUpdates(mainWindow)).catch(() => void 0);
  }, 8_000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopWatchers();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopWatchers();
  if (servingTimer) clearInterval(servingTimer);
  servingTimer = null;
  // Hand the Central WebSocket back cleanly so an installed always-on service
  // can take it over immediately instead of waiting out the lock heartbeat.
  void service.stopNode();
});
