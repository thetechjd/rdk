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
      try { await service.initNode(opts); startWatchers(); return { ok: true }; }
      catch (e) { return { ok: false, error: (e as Error).message }; }
    },
    // vault
    getVaultTree: () => service.getVaultTree(),
    indexPaths: (paths: never, visibility: never) => service.indexPaths(paths, visibility),
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
    pinChunk: () => service.pinChunk(),
    deleteChunk: (id: never) => service.deleteChunk(id),
    getRetrievedFor: (id: never) => service.getRetrievedFor(id),
    getVersions: (sourcePath: never) => service.getVersions(sourcePath),
    // graph + query
    getGraphData: () => service.getGraphData(),
    query: (q: never) => service.query(q),
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
    openTopUp: async () => { await shell.openExternal(`${service.getDashboardUrl()}/balance`); },
    getEarnings: () => service.getEarnings(),
    // Billing (RetroDeck API). selectPlan/createTopup open the web checkout
    // themselves; the renderer then polls verifySubscription/verifyTopup.
    getPlans: () => service.getPlans(),
    selectPlan: (planId: never, interval: never) => service.selectPlan(planId, interval),
    verifySubscription: () => service.verifySubscription(),
    createTopup: (amountUsd: never, method: never) => service.createTopup(amountUsd, method),
    verifyTopup: (paymentRef: never) => service.verifyTopup(paymentRef),
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

app.whenReady().then(() => {
  registerHandlers();
  createWindow();
  if (service.isInitialized()) startWatchers();

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

app.on('before-quit', () => stopWatchers());
