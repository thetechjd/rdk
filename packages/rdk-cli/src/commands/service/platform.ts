// packages/rdk-cli/src/commands/service/platform.ts

import os from 'os';
import fs from 'fs';

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
 * Every install method is node-based, so execPath is the absolute Node and
 * argv[1] is the absolute cli.js:
 *   - brew  → node@22 under the Cellar; execPath + cli.js are absolute.
 *   - curl  → bundled node under ~/.rdk/runtime; both absolute.
 *   - npm   → global cli.js; execPath is the absolute node (even nvm/fnm/volta).
 *
 * Because every path is absolute, the service survives a minimal launchd /
 * systemd PATH and never depends on `node` being discoverable at boot.
 *
 * Homebrew caveat: a Cellar path (…/Cellar/<formula>/<version>/…) is absolute
 * but VERSION-PINNED — `brew upgrade` deletes the old version dir, orphaning a
 * baked-in service path and sending launchd/systemd into a MODULE_NOT_FOUND
 * crash-loop. So we rewrite Cellar paths to the stable `opt` symlink, which
 * Homebrew repoints to the current version on every upgrade.
 */
function stabilizeBrewPath(p: string): string {
  // …/Cellar/<formula>/<version>/<rest>  →  …/opt/<formula>/<rest>
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.*)$/.exec(p);
  if (!m) return p;
  const stable = `${m[1]}/opt/${m[2]}/${m[3]}`;
  // Only use the rewrite if it actually resolves — never make the path worse.
  return fs.existsSync(stable) ? stable : p;
}

export function resolveLaunch(...extraArgs: string[]): LaunchSpec {
  return {
    command: stabilizeBrewPath(process.execPath),
    args: [stabilizeBrewPath(process.argv[1]), ...extraArgs],
  };
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
