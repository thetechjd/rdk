// packages/rdk-node/src/service/index.ts
// OS auto-start for a headless RDK node: launchd (macOS), systemd user units
// (Linux), Task Scheduler (Windows). Shared by the CLI and the desktop app —
// each passes the LaunchSpec that re-invokes ITSELF in serve mode, so the
// desktop never needs the CLI installed to run as a background service.

import os from 'os';

export type Platform = 'macos' | 'linux' | 'windows' | 'unsupported';

export function detectPlatform(): Platform {
  switch (os.platform()) {
    case 'darwin': return 'macos';
    case 'linux':  return 'linux';
    case 'win32':  return 'windows';
    default:       return 'unsupported';
  }
}

export interface LaunchSpec {
  /** Absolute path to the executable to run. */
  command: string;
  /** Arguments to pass. */
  args: string[];
  /** Extra environment for the process. Not supported by the Windows adapter
   *  (Task Scheduler has no per-task environment) — it throws if one is given. */
  env?: Record<string, string>;
}

export interface ServiceAdapter {
  install(launch: LaunchSpec): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<ServiceStatus>;
}

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  lastError?: string;
}

export async function getServiceAdapter(): Promise<ServiceAdapter> {
  const platform = detectPlatform();
  switch (platform) {
    case 'macos':   return (await import('./macos.js')).MacOSAdapter;
    case 'linux':   return (await import('./linux.js')).LinuxAdapter;
    case 'windows': return (await import('./windows.js')).WindowsAdapter;
    default:
      throw new Error(`Unsupported platform: ${os.platform()}`);
  }
}
