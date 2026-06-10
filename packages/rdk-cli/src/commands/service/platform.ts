// packages/rdk-cli/src/commands/service/platform.ts

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

export interface ServiceAdapter {
  install(): Promise<void>;
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

export async function getAdapter(): Promise<ServiceAdapter> {
  const platform = detectPlatform();
  switch (platform) {
    case 'macos':   return (await import('./macos.js')).MacOSAdapter;
    case 'linux':   return (await import('./linux.js')).LinuxAdapter;
    case 'windows': return (await import('./windows.js')).WindowsAdapter;
    default:
      throw new Error(`Unsupported platform: ${os.platform()}`);
  }
}
