import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Holding the lock is not the job — serving content is.
 *
 * `wsHeldByOther()` only asked whether the owner was ALIVE, and the owner
 * refreshed its timestamp every 30s regardless of whether it had a socket. So a
 * process that claimed the lock and then never connected blocked every other
 * process indefinitely: the desktop deferred to it forever and sat at
 * "connecting…", waiting on work the holder was not doing.
 *
 * Reported as "now it just hangs on 'connecting' status", after the user had run
 * `rdk mcp:serve` — which is exactly a second process that can claim this lock.
 */

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-lock-'));
  process.env.RDK_HOME = home;
});
afterEach(() => {
  delete process.env.RDK_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const LOCK = () => path.join(home, 'ws-owner.lock');

/** A pid that is certainly alive and certainly not us. */
const OTHER_PID = process.ppid;

function writeLock(data: Record<string, unknown>): void {
  fs.writeFileSync(LOCK(), JSON.stringify({ pid: OTHER_PID, ...data }));
}

// The module resolves the lock path once at import, so it must be re-imported
// after RDK_HOME is pointed at this test's temp directory.
async function heldByOther(): Promise<boolean> {
  vi.resetModules();
  const { wsHeldByOther } = await import('../src/ws/ws-lock.js');
  return wsHeldByOther();
}

describe('deferring to another process', () => {
  it('defers to an owner that is actually connected', async () => {
    writeLock({ ts: Date.now(), connected: true, since: Date.now() });
    expect(await heldByOther()).toBe(true);
  });

  it('defers briefly to an owner that just claimed and is still connecting', async () => {
    writeLock({ ts: Date.now(), connected: false, since: Date.now() });
    expect(await heldByOther()).toBe(true);
  });

  it('TAKES OVER from an owner that has been failing to connect', async () => {
    // The deadlock: `ts` is fresh because the owner refreshes every 30s, but it
    // has had no socket for minutes. Previously this returned true forever.
    const now = Date.now();
    writeLock({ ts: now, connected: false, since: now - 5 * 60_000 });
    expect(await heldByOther()).toBe(false);
  });

  it('takes over from a dead owner', async () => {
    writeLock({ pid: 999_999_999, ts: Date.now(), connected: true, since: Date.now() });
    expect(await heldByOther()).toBe(false);
  });

  it('takes over when the claim itself has gone stale', async () => {
    writeLock({ ts: Date.now() - 5 * 60_000, connected: true, since: Date.now() - 5 * 60_000 });
    expect(await heldByOther()).toBe(false);
  });

  it('is unheld when no lock exists', async () => {
    expect(await heldByOther()).toBe(false);
  });

  it('tolerates a lock file written by an older build with no `since`', async () => {
    // Falls back to `ts`, which is the old behaviour — never worse than before.
    writeLock({ ts: Date.now(), connected: false });
    expect(await heldByOther()).toBe(true);
  });
});

/**
 * claimWs used to overwrite the lock unconditionally, so every contender
 * "succeeded" and they all drove sockets at once. Central permits one session
 * per node and closes the older with 4001, so the survivors' next tick
 * reconnected and superseded each other — 208 connections in five minutes from
 * a single node, with Central's CPU pinned. Claiming must be able to FAIL.
 */
describe('claiming ownership', () => {
  async function lockApi() {
    vi.resetModules();
    return import('../src/ws/ws-lock.js');
  }

  it('refuses to steal the lock from a live, connected owner', async () => {
    writeLock({ ts: Date.now(), connected: true, since: Date.now() });
    const { claimWs, weOwnWs } = await lockApi();

    expect(claimWs(false)).toBe(false);
    expect(weOwnWs()).toBe(false);
    // The incumbent's claim must survive untouched.
    expect(JSON.parse(fs.readFileSync(LOCK(), 'utf8')).pid).toBe(OTHER_PID);
  });

  it('claims a free lock and reports ownership', async () => {
    const { claimWs, weOwnWs } = await lockApi();

    expect(claimWs(false)).toBe(true);
    expect(weOwnWs()).toBe(true);
    expect(JSON.parse(fs.readFileSync(LOCK(), 'utf8')).pid).toBe(process.pid);
  });

  it('takes over from a dead owner', async () => {
    writeLock({ pid: 999_999_999, ts: Date.now(), connected: true, since: Date.now() });
    const { claimWs, weOwnWs } = await lockApi();

    expect(claimWs(false)).toBe(true);
    expect(weOwnWs()).toBe(true);
  });

  it('reports loss of ownership once another process takes the lock', async () => {
    const { claimWs, weOwnWs } = await lockApi();
    expect(claimWs(true)).toBe(true);
    expect(weOwnWs()).toBe(true);

    // Another process wins the race and writes after us.
    writeLock({ ts: Date.now(), connected: true, since: Date.now() });

    // The owner must notice rather than carrying on and superseding it forever.
    expect(weOwnWs()).toBe(false);
    expect(claimWs(true)).toBe(false);
  });
});
