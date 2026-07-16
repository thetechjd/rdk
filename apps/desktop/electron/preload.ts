// electron/preload.ts
// The ONLY bridge between the sandboxed renderer and the Node main process.
// contextIsolation is ON and nodeIntegration is OFF (see main.ts) — the renderer
// can touch nothing but the typed `window.rdk` surface built here.

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { RDK_CHANNELS, PUSH_CHANNEL, type RdkApi, type PushEvent } from '../shared/ipc';

// Build one invoke-forwarding function per channel, so the API stays in lockstep
// with the shared contract without hand-writing 40 identical wrappers.
const api = Object.fromEntries(
  RDK_CHANNELS.map((ch) => [ch, (...args: unknown[]) => ipcRenderer.invoke(ch, ...args)]),
) as unknown as Omit<RdkApi, 'onPush'>;

const onPush: RdkApi['onPush'] = (handler: (e: PushEvent) => void) => {
  const listener = (_e: Electron.IpcRendererEvent, payload: PushEvent) => handler(payload);
  ipcRenderer.on(PUSH_CHANNEL, listener);
  return () => ipcRenderer.removeListener(PUSH_CHANNEL, listener);
};

const rdk: RdkApi = { ...api, onPush };

contextBridge.exposeInMainWorld('rdk', rdk);

// Resolve the absolute path of a file dropped from Finder/Explorer. webUtils is
// the supported replacement for the removed File.path; both processes share the
// renderer, so passing the File across the bridge is safe.
contextBridge.exposeInMainWorld('rdkNative', {
  pathForFile: (file: File): string => {
    try { return webUtils.getPathForFile(file); }
    catch { return (file as unknown as { path?: string }).path ?? ''; }
  },
});
