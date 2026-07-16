// packages/rdk-node/src/ws/ws-lock.ts
// Single-owner lock for the RDK Central WebSocket.
//
// A node may have several `rdk mcp:serve` processes at once (the always-on
// launchd/systemd service AND the instance Claude Desktop spawns for its MCP
// tools). Central allows only ONE WebSocket session per node — each new connect
// kicks the previous with close code 4001. Left unmanaged the session flaps and
// content/promote/delete commands intermittently hit "node offline".
//
// This lock lets exactly one process own the Central connection. The others
// still serve their MCP stdio tools + local HTTP, they just don't open a
// competing WebSocket. Ownership is heartbeated so that if the owner dies, any
// other live instance takes over on its next tick.

import fs from 'fs';
import os from 'os';
import path from 'path';

const LOCK_PATH = path.join(
  process.env.RDK_HOME ?? path.join(os.homedir(), '.rdk'),
  'ws-owner.lock',
);

// Owner refreshes every 30s; treat a lock older than this as abandoned.
const STALE_MS = 90_000;

interface LockData { pid: number; ts: number }

function readLock(): LockData | null {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')) as LockData;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** True if a DIFFERENT, live process currently owns the Central WS. */
export function wsHeldByOther(): boolean {
  const lock = readLock();
  if (!lock || lock.pid === process.pid) return false;
  return isAlive(lock.pid) && Date.now() - lock.ts < STALE_MS;
}

/** Claim/refresh ownership for this process. */
export function claimWs(): void {
  try {
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, ts: Date.now() }), { mode: 0o600 });
  } catch {
    // Non-fatal — worst case we fall back to the unmanaged behavior.
  }
}

/** Release ownership, but only if this process is the current owner. */
export function releaseWs(): void {
  try {
    const lock = readLock();
    if (lock && lock.pid === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch {
    // Non-fatal.
  }
}
