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

export interface LaunchSpec {
  /** Absolute path to the executable to run. */
  command: string;
  /** Arguments to pass, with any extra args appended. */
  args: string[];
}

/**
 * Resolve exactly how to re-invoke this rdk binary, derived from the
 * currently-running process rather than a PATH lookup.
 *
 * This is what makes auto-start identical across install methods:
 *   - brew  → standalone @yao-pkg/pkg binary; `process.execPath` IS rdk.
 *   - curl  → bundled node under ~/.rdk/runtime; execPath + cli.js are absolute.
 *   - npm   → global cli.js; execPath is the absolute node (even nvm/fnm/volta).
 *
 * Because every path is absolute, the service survives a minimal launchd /
 * systemd PATH and never depends on `node` being discoverable at boot.
 */
export function resolveLaunch(...extraArgs: string[]): LaunchSpec {
  // @yao-pkg/pkg sets process.pkg on the packaged standalone binary.
  if ((process as unknown as { pkg?: unknown }).pkg) {
    return { command: process.execPath, args: [...extraArgs] };
  }
  // node-based install: execPath is the absolute node, argv[1] the cli.js.
  return { command: process.execPath, args: [process.argv[1], ...extraArgs] };
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
