// packages/rdk-node/src/ws/ws-presence.ts
//
// Who on this machine is serving the node, for display only.
//
// This replaces `ws-lock`. That file existed because Central kept ONE session
// per node and closed the previous one with 4001, so the RDK processes on a
// machine — the desktop app, `rdk mcp:serve` under Claude Desktop, a one-off
// `rdk query` — had to negotiate for the right to connect. They all read the
// same local store, so the arbitration bought nothing and cost plenty: when it
// slipped, the losers reconnected in a loop and superseded each other, once at
// 208 connections in five minutes from a single node. Central now holds every
// session at once, so there is nothing left to arbitrate.
//
// What remains is the part that was actually missing. The old lock recorded a
// pid and nothing else, so no surface could say more than "another RDK process
// holds the connection" — true, useless, and the reason a user staring at the
// desktop had no idea Claude Desktop was already serving their node. Each
// process now announces WHO it is, and nobody is ever blocked.

import fs from 'fs';
import os from 'os';
import path from 'path';

export type RdkApp = 'desktop' | 'cli' | 'mcp' | 'service' | 'unknown';

export interface WsPresence {
  pid: number;
  app: RdkApp;
  /** Human name for a UI: "RDK Desktop", "Claude Desktop (rdk mcp:serve)". */
  label: string;
  /** An OPEN socket to Central, not merely an intent to open one. */
  connected: boolean;
  /** Last refresh. Entries older than STALE_MS are ignored. */
  ts: number;
}

/** Entries are refreshed every 30s; treat anything older than this as gone. */
const STALE_MS = 90_000;

const DEFAULT_LABELS: Record<RdkApp, string> = {
  desktop: 'RDK Desktop',
  cli: 'RDK CLI',
  mcp: 'rdk mcp:serve',
  service: 'RDK background service',
  unknown: 'an RDK process',
};

function rdkHome(): string {
  return process.env.RDK_HOME ?? path.join(os.homedir(), '.rdk');
}

/**
 * One file per process, named by pid.
 *
 * A shared file would need read-modify-write from several processes at once,
 * which is the class of race this module exists to stop repeating. Owning your
 * own filename removes it: nobody ever writes anybody else's entry.
 */
function presenceDir(): string {
  return path.join(rdkHome(), 'ws-sessions');
}

function entryPath(pid = process.pid): string {
  return path.join(presenceDir(), `${pid}.json`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process EXISTS but belongs to someone we may not signal.
    // Only ESRCH means "no such process" — treating EPERM as dead would delete
    // a live process's entry and report the node as unserved while it serves.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Record (or refresh) this process. Never blocks and never fails loudly. */
export function announceWs(state: { app: RdkApp; label?: string; connected: boolean }): void {
  try {
    const entry: WsPresence = {
      pid: process.pid,
      app: state.app,
      label: state.label ?? process.env.RDK_APP_LABEL ?? DEFAULT_LABELS[state.app],
      connected: state.connected,
      ts: Date.now(),
    };
    fs.mkdirSync(presenceDir(), { recursive: true });
    fs.writeFileSync(entryPath(), JSON.stringify(entry), { mode: 0o600 });
  } catch {
    // Presence is decoration. Losing it must never stop a node from serving.
  }
}

/** Remove this process's entry, on clean shutdown. */
export function clearWs(): void {
  try { fs.unlinkSync(entryPath()); } catch { /* already gone */ }
}

/**
 * Every RDK process on this machine that is currently serving, most recently
 * refreshed first. Dead and stale entries are dropped as they are found — a
 * process killed with SIGKILL never gets to clean up after itself.
 */
export function listWsPresence(opts: { includeSelf?: boolean } = {}): WsPresence[] {
  let files: string[];
  try {
    files = fs.readdirSync(presenceDir());
  } catch {
    return [];
  }

  const now = Date.now();
  const live: WsPresence[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(presenceDir(), file);
    let entry: WsPresence | null = null;
    try {
      entry = JSON.parse(fs.readFileSync(full, 'utf8')) as WsPresence;
    } catch {
      entry = null;
    }
    const dead = !entry || !isAlive(entry.pid) || now - entry.ts >= STALE_MS;
    if (dead) {
      try { fs.unlinkSync(full); } catch { /* raced with its owner */ }
      continue;
    }
    if (!opts.includeSelf && entry!.pid === process.pid) continue;
    live.push(entry!);
  }
  return live.sort((a, b) => b.ts - a.ts);
}

/** Processes other than this one that hold an OPEN socket right now. */
export function otherWsServers(): WsPresence[] {
  return listWsPresence().filter((p) => p.connected);
}

/**
 * A sentence naming who else is serving, or null when nobody is.
 *
 * The point of the whole module: "Claude Desktop is also serving this node"
 * instead of "another RDK process holds the Central connection".
 */
export function describeOtherWsServers(): string | null {
  const names = [...new Set(otherWsServers().map((p) => p.label))];
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
