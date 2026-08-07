import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Presence replaced the single-owner lock.
 *
 * The lock let exactly one RDK process on a machine hold the Central socket,
 * because Central kept one session per node and closed the previous with 4001.
 * Central now holds them all, so nothing arbitrates and nothing is blocked —
 * what is left is naming who is serving, which the lock could never do: it
 * stored a pid, so every surface could only say "another RDK process holds the
 * Central connection" while the user wondered which one.
 *
 * These assert the two properties the UIs depend on: a live process is NAMED,
 * and a dead one is not counted (its entry outlives it — nothing cleans up
 * after SIGKILL).
 */

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-presence-'));
  process.env.RDK_HOME = home;
});
afterEach(() => {
  delete process.env.RDK_HOME;
  delete process.env.RDK_APP_LABEL;
  fs.rmSync(home, { recursive: true, force: true });
});

const dir = () => path.join(home, 'ws-sessions');

/** A pid that is certainly alive and certainly not us. */
const OTHER_PID = process.ppid;
/** Unlikely to exist, and never this process. */
const DEAD_PID = 2_147_483_646;

/** A second live process we own, for the "several apps at once" case. */
let child: ChildProcess;
beforeAll(() => { child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); });
afterAll(() => { child?.kill('SIGKILL'); });

function writeEntry(pid: number, entry: Record<string, unknown>): void {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(
    path.join(dir(), `${pid}.json`),
    JSON.stringify({ pid, app: 'mcp', label: 'rdk mcp:serve', connected: true, ts: Date.now(), ...entry }),
  );
}

// The module resolves RDK_HOME per call, but re-import anyway so each test is
// isolated from any module state.
async function presence() {
  vi.resetModules();
  return import('../src/ws/ws-presence.js');
}

describe('naming who is serving', () => {
  it('names a live process instead of calling it "another RDK process"', async () => {
    writeEntry(OTHER_PID, { label: 'Claude Desktop (rdk mcp:serve)' });
    const { describeOtherWsServers } = await presence();
    expect(describeOtherWsServers()).toBe('Claude Desktop (rdk mcp:serve)');
  });

  it('lists every process serving at once', async () => {
    writeEntry(OTHER_PID, { label: 'Claude Desktop (rdk mcp:serve)' });
    writeEntry(child.pid!, { label: 'RDK background service' });
    const { describeOtherWsServers } = await presence();
    // Both are named — the point of allowing simultaneous sessions at all.
    expect(describeOtherWsServers()).toContain('Claude Desktop');
    expect(describeOtherWsServers()).toContain('RDK background service');
  });

  it('says nothing when nobody else is serving', async () => {
    const { describeOtherWsServers, otherWsServers } = await presence();
    expect(describeOtherWsServers()).toBeNull();
    expect(otherWsServers()).toEqual([]);
  });

  it('ignores a process that has a claim but no open socket', async () => {
    // Announcing intent is not serving. Counting it would tell the user their
    // content is retrievable while Central skips every chunk of it.
    writeEntry(OTHER_PID, { connected: false });
    const { otherWsServers } = await presence();
    expect(otherWsServers()).toEqual([]);
  });
});

describe('processes that are gone', () => {
  it('does not count a dead process, and cleans up after it', async () => {
    // Nothing runs on exit after SIGKILL, so its entry outlives it.
    writeEntry(DEAD_PID, { label: 'RDK Desktop' });
    const { otherWsServers } = await presence();
    expect(otherWsServers()).toEqual([]);
    expect(fs.existsSync(path.join(dir(), `${DEAD_PID}.json`))).toBe(false);
  });

  it('counts a live process owned by another user', async () => {
    // `process.kill(pid, 0)` throws EPERM for a process we may not signal — it
    // EXISTS. Reading that as dead would delete a serving process's entry and
    // tell the user their node is unreachable while it is being served.
    writeEntry(1, { label: 'RDK background service' });   // pid 1: alive, not ours
    const { otherWsServers } = await presence();
    expect(otherWsServers().map((p) => p.label)).toEqual(['RDK background service']);
  });

  it('does not count a live process that stopped refreshing', async () => {
    // Alive but wedged: the entry is two minutes old, past STALE_MS.
    writeEntry(OTHER_PID, { ts: Date.now() - 120_000 });
    const { otherWsServers } = await presence();
    expect(otherWsServers()).toEqual([]);
  });

  it('survives a corrupt entry rather than blinding every surface', async () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), '999999.json'), 'not json{');
    writeEntry(OTHER_PID, { label: 'RDK Desktop' });
    const { describeOtherWsServers } = await presence();
    expect(describeOtherWsServers()).toBe('RDK Desktop');
  });
});

describe('announcing this process', () => {
  it('records and then withdraws its own entry', async () => {
    const { announceWs, clearWs, listWsPresence } = await presence();

    announceWs({ app: 'desktop', connected: true });
    expect(listWsPresence({ includeSelf: true }).map((p) => p.label)).toEqual(['RDK Desktop']);
    // Excluded from "others" — a surface must not report ITSELF as the reason
    // the node is reachable.
    expect(listWsPresence()).toEqual([]);

    clearWs();
    expect(listWsPresence({ includeSelf: true })).toEqual([]);
  });

  it('lets the spawning app name itself through RDK_APP_LABEL', async () => {
    // Claude Desktop spawns `rdk mcp:serve`; only the spawner knows that.
    process.env.RDK_APP_LABEL = 'Claude Desktop (rdk mcp:serve)';
    const { announceWs, listWsPresence } = await presence();
    announceWs({ app: 'mcp', connected: true });
    expect(listWsPresence({ includeSelf: true })[0].label).toBe('Claude Desktop (rdk mcp:serve)');
  });

  it('never throws when the home directory cannot be created', async () => {
    // Presence is decoration; losing it must not stop a node from serving.
    // A path that runs THROUGH a regular file fails with ENOTDIR — a portable
    // stand-in for any unwritable home.
    const blocker = path.join(home, 'not-a-directory');
    fs.writeFileSync(blocker, 'x');
    process.env.RDK_HOME = path.join(blocker, 'nested');
    const { announceWs, listWsPresence } = await presence();
    expect(() => announceWs({ app: 'cli', connected: true })).not.toThrow();
    expect(listWsPresence()).toEqual([]);
  });
});
