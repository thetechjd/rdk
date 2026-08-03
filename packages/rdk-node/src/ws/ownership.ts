// packages/rdk-node/src/ws/ownership.ts
// Owning the Central WebSocket, in one place.
//
// A node's content lives on the node. Central can only answer a query with that
// content while the node holds a live WebSocket session — offline means every
// one of that node's chunks is silently skipped by the query router. So every
// surface that represents "my node is running" (the desktop app, `rdk mcp:serve`,
// a one-off `rdk query`) has to hold this connection, and they must all do it the
// same way.
//
// Central allows ONE session per node — a second connect kicks the first with
// close code 4001. `ws-lock` decides which local process owns the socket; the
// others run without one. This module wraps claim → connect → heartbeat →
// release so the desktop and the CLI cannot drift apart in how they do it.

import { getWsClient, type RdkWebSocketClient } from './client.js';
import { claimWs, releaseWs, wsHeldByOther } from './ws-lock.js';

/** How often the owner refreshes the lock (must stay under ws-lock's STALE_MS). */
const OWNER_TICK_MS = 30_000;

export interface WsOwnershipOptions {
  /** Diagnostics sink. Defaults to silence — the desktop surfaces state via
   *  getStatus(), the CLI prints to stderr. */
  log?: (message: string) => void;
}

export interface WsOwnership {
  /** True when THIS process holds the lock and drives the socket. */
  isOwner(): boolean;
  /** True when this process has a live socket to Central right now. */
  isConnected(): boolean;
  /** Stop the ownership loop, close our socket, and release the lock. */
  stop(): void;
}

/**
 * Start contending for the Central WebSocket. Returns null when this machine has
 * no usable node identity (not signed in, or an offline `local-` node).
 *
 * Safe to call when another process (e.g. the always-on service) already owns the
 * connection: we simply don't open a competing socket, and take over on a later
 * tick if that process dies.
 */
export function startWsOwnership(opts: WsOwnershipOptions = {}): WsOwnership | null {
  const client = getWsClient();
  if (!client) return null;

  const log = opts.log ?? (() => {});
  let owner = false;
  let stopped = false;

  client.on('connected', () => {
    if (owner) claimWs(true);
    log('connected to RDK Central — serving content');
  });
  client.on('disconnected', ({ code, reason }: { code: number; reason: string }) => {
    if (owner) claimWs(false);
    if (code !== 1000) log(`disconnected from RDK Central (${code})${reason ? ': ' + reason : ''}`);
  });

  const ensureOwner = (): void => {
    if (stopped) return;
    if (owner) {
      // Ownership is re-verified, never assumed. Two processes can both claim a
      // free lock at startup; the loser must stand down instead of continuing to
      // reconnect, or the two supersede each other forever (Central permits one
      // session per node and closes the older with 4001).
      if (!claimWs(client.isConnected())) {
        owner = false;
        log('another RDK process took the Central connection — standing down');
        client.disconnect();
        return;
      }
      // Keep trying while we hold the lock. A 4001 ("another instance took
      // over") permanently disables this client's automatic reconnect, so if
      // that other instance later dies, nothing would ever reopen the socket
      // and the node would sit at "connecting" for the rest of its life.
      // connect() no-ops when a socket already exists, so this is safe to call.
      if (!client.isConnected()) void client.connect();
      return;
    }
    if (wsHeldByOther()) return;             // another instance owns it
    // Only drive the socket if the claim actually succeeded.
    if (!claimWs(false)) return;
    owner = true;
    log('holding the RDK Central connection for this node');
    void client.connect();
  };

  ensureOwner();
  if (!owner) log('another RDK process holds the Central connection');

  const tick = setInterval(ensureOwner, OWNER_TICK_MS);
  if (typeof tick.unref === 'function') tick.unref();

  return {
    isOwner: () => owner,
    isConnected: () => client.isConnected(),
    stop: () => {
      stopped = true;
      clearInterval(tick);
      if (owner) {
        client.disconnect();
        releaseWs();
        owner = false;
      }
    },
  };
}

/**
 * Hold the Central connection for the duration of one short-lived command (e.g.
 * `rdk query`), so a user who hasn't installed the always-on service can still
 * retrieve their own content. No-ops into a plain pass-through when another
 * process already owns the socket — that process serves the fetch instead.
 *
 * Waits (briefly) for the socket to come up before running `fn`, because Central
 * fetches content synchronously while answering the query.
 */
export async function withWsConnection<T>(
  fn: () => Promise<T>,
  opts: WsOwnershipOptions & { readyTimeoutMs?: number } = {},
): Promise<T> {
  const ownership = startWsOwnership(opts);
  if (!ownership) return fn();

  try {
    if (ownership.isOwner()) {
      await waitForConnection(ownership, opts.readyTimeoutMs ?? 5_000);
    }
    return await fn();
  } finally {
    ownership.stop();
  }
}

async function waitForConnection(ownership: WsOwnership, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ownership.isConnected() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export type { RdkWebSocketClient };
