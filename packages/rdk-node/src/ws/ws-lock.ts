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

/**
 * How long an owner may hold the lock WITHOUT an open socket before another
 * process is allowed to take over.
 *
 * Holding the lock is not the job — serving content is. An owner that claims it
 * and then never connects used to block every other process indefinitely,
 * because the staleness check only asked whether the owner was alive and the
 * owner refreshed its timestamp every 30s regardless. The desktop then sat at
 * "connecting…" forever, deferring to a process that was doing nothing.
 */
const CONNECT_GRACE_MS = 45_000;

interface LockData {
  pid: number;
  ts: number;
  /** The owner process has an OPEN WebSocket, not merely an intent to connect. */
  connected?: boolean;
  /** When this owner last had (or first sought) a socket. Unlike `ts`, this does
   *  NOT move on every refresh, so "has been trying and failing for a while" is
   *  distinguishable from "just refreshed its claim". */
  since?: number;
}

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

/**
 * True if a DIFFERENT, live process currently owns the Central WS *and is
 * actually using it* — or has claimed it recently enough to still be connecting.
 *
 * Deferring to a live owner that never connects is a deadlock: the holder
 * refreshes its claim every 30s so it never goes stale, and everyone else waits
 * forever on work it is not doing.
 */
export function wsHeldByOther(): boolean {
  const lock = readLock();
  if (!lock || lock.pid === process.pid) return false;
  if (!isAlive(lock.pid) || Date.now() - lock.ts >= STALE_MS) return false;
  if (lock.connected === true) return true;
  // Claimed but not connected: give it a grace period, then take over.
  return Date.now() - (lock.since ?? lock.ts) < CONNECT_GRACE_MS;
}

/** True only when another live process reports an OPEN Central socket. */
export function wsConnectionHeldByOther(): boolean {
  const lock = readLock();
  if (!lock || lock.pid === process.pid) return false;
  return lock.connected === true
    && isAlive(lock.pid)
    && Date.now() - lock.ts < STALE_MS;
}

/**
 * True when the lock on disk currently belongs to THIS process.
 *
 * Ownership must be re-checked, not remembered. Two processes starting together
 * can both find the lock free and both claim it; whoever writes last owns it,
 * and the other has to notice it lost rather than carrying on as owner.
 */
export function weOwnWs(): boolean {
  const lock = readLock();
  return lock !== null && lock.pid === process.pid && Date.now() - lock.ts < STALE_MS;
}

/**
 * Claim or refresh ownership. Returns true only if this process holds the lock
 * afterwards.
 *
 * Refuses to take it from a live owner that is still within its grace period —
 * previously this overwrote the lock unconditionally, so every contender
 * "succeeded" and they all drove sockets at once. Central allows one session per
 * node, so each connect kicked the others with 4001, and the survivors' next
 * tick reconnected: a supersede loop that saturated Central at 208 connections
 * per five minutes from a single node.
 *
 * The write is still last-writer-wins, so it is verified by reading back.
 */
export function claimWs(connected = false): boolean {
  try {
    if (wsHeldByOther()) return false;

    const now = Date.now();
    const prev = readLock();
    // `since` marks when this process last had a socket, or first started trying
    // for one. Carrying it across refreshes is what lets others tell a healthy
    // owner from one that has been failing to connect for minutes.
    const since = connected || prev?.pid !== process.pid ? now : prev.since ?? now;
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    fs.writeFileSync(
      LOCK_PATH,
      JSON.stringify({ pid: process.pid, ts: now, connected, since }),
      { mode: 0o600 },
    );
    // Read back: if a racing process wrote after us, we do not own it.
    return weOwnWs();
  } catch {
    // Non-fatal — worst case we fall back to the unmanaged behavior.
    return false;
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
