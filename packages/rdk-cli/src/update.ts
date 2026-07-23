// packages/rdk-cli/src/update.ts
//
// Update notice + self-update for the rdk CLI.
//
// Notice (update-notifier pattern — ZERO added latency): on startup we read a tiny
// cache (~/.rdk/update-check.json) and print a one-line notice if it already says a
// newer version exists. If the cache is stale (>24h) we spawn a short-lived DETACHED
// refresher that fetches the registry and rewrites the cache for the NEXT run — the
// current invocation never waits on the network.
//
// `rdk update`: fresh registry check, detects how the CLI was installed (Homebrew vs
// npm), asks to confirm, then runs the matching upgrade command (Windows-safe: npm is
// npm.cmd, which needs a shell to resolve).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync, type SpawnSyncOptions } from 'child_process';
import { t } from './theme.js';

const PKG = '@retrodeck/rdk';
const CACHE = path.join(process.env.RDK_HOME ?? path.join(os.homedir(), '.rdk'), 'update-check.json');
const TTL_MS = 24 * 60 * 60 * 1000;

interface UpdateCache { latest?: string; checkedAt?: number }

function readCache(): UpdateCache {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')) as UpdateCache; } catch { return {}; }
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Startup hook: print a cached update notice (stderr, TTY only) and refresh the
 *  cache in the background for the next run. Never blocks, never throws. */
export function maybeNotifyUpdate(currentVersion: string): void {
  try {
    if (!process.stderr.isTTY) return; // never pollute scripted/piped runs
    const c = readCache();
    if (c.latest && cmpVersion(c.latest, currentVersion) > 0) {
      console.error(t.dim(`  update available: ${currentVersion} → ${c.latest} · run \`rdk update\``));
    }
    if (!c.checkedAt || Date.now() - c.checkedAt > TTL_MS) {
      // Detached refresher (unref'd, stdio ignored) — the parent never waits.
      const script =
        `fetch('https://registry.npmjs.org/${PKG}/latest',{signal:AbortSignal.timeout(5000)})` +
        `.then(r=>r.json())` +
        `.then(d=>require('fs').writeFileSync(${JSON.stringify(CACHE)},JSON.stringify({latest:d.version,checkedAt:Date.now()})))` +
        `.catch(()=>{})`;
      spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* update notices must never break the CLI */ }
}

/** True when the running binary resolves into a Homebrew cellar. */
function isBrewInstall(): boolean {
  try {
    const real = fs.realpathSync(process.argv[1] ?? '');
    return /[/\\](Cellar|homebrew|linuxbrew)[/\\]/i.test(real);
  } catch {
    return false;
  }
}

/** Windows-safe spawn: npm/brew shims need a shell to resolve (.cmd + PATHEXT). */
function run(cmd: string, args: string[]): number {
  const opts: SpawnSyncOptions = { stdio: 'inherit' };
  const r = process.platform === 'win32'
    ? spawnSync(cmd, args.map((a) => `"${a.replace(/"/g, '""')}"`), { ...opts, shell: true })
    : spawnSync(cmd, args, opts);
  return r.status ?? 1;
}

export async function runUpdate(currentVersion: string, opts: { yes?: boolean } = {}): Promise<void> {
  let latest: string | undefined;
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG}/latest`, { signal: AbortSignal.timeout(8000) });
    latest = ((await res.json()) as { version?: string }).version;
  } catch { /* handled below */ }

  if (!latest) {
    console.log(t.warn('Could not reach the npm registry to check for updates.'));
    return;
  }
  if (cmpVersion(latest, currentVersion) <= 0) {
    console.log(t.body(`rdk ${currentVersion} is up to date.`));
    return;
  }

  const brew = isBrewInstall();
  const how = brew ? 'brew upgrade rdk' : `npm install -g ${PKG}@latest`;
  console.log(t.body(`Update available: ${currentVersion} → ${latest}`));
  console.log(t.dim(`  install method: ${brew ? 'Homebrew' : 'npm'} → ${how}`));

  if (!opts.yes) {
    const { confirm } = await import('./prompts.js');
    if (!(await confirm({ message: `Update to ${latest} now?`, default: true }))) return;
  }

  const code = brew ? run('brew', ['upgrade', 'rdk']) : run('npm', ['install', '-g', `${PKG}@latest`]);
  if (code === 0) {
    try { fs.writeFileSync(CACHE, JSON.stringify({ latest, checkedAt: Date.now() })); } catch { /* non-fatal */ }
    console.log(t.body(`Updated. Run \`rdk --version\` to confirm ${latest}.`));
  } else {
    console.log(t.warn(`Update command failed (exit ${code}). Run it manually: ${how}`));
  }
}
