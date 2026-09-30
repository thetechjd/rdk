// packages/rdk-cli/src/commands/service/platform.ts

import fs from 'fs';
import {
  detectPlatform,
  getServiceAdapter,
  type LaunchSpec,
  type ServiceAdapter,
} from '@rdk/node/service';

// The OS adapters live in @rdk/node so the desktop app can install the same
// service without the CLI. The CLI's only job here is saying how to re-invoke
// itself.
export { detectPlatform, type LaunchSpec };

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

/** The OS adapter, bound to re-invoke this CLI as `rdk mcp:serve`. */
export async function getAdapter(): Promise<Omit<ServiceAdapter, 'install'> & { install(): Promise<void> }> {
  const adapter = await getServiceAdapter();
  return { ...adapter, install: () => adapter.install(resolveLaunch('mcp:serve')) };
}
