// packages/rdk-node/src/ws/ownership.ts
// Holding the Central WebSocket, in one place.
//
// A node's content lives on the node. Central can only answer a query with that
// content while the node holds a live WebSocket session — offline means every
// one of that node's chunks is silently skipped by the query router. So every
// surface that represents "my node is running" (the desktop app, `rdk mcp:serve`,
// a one-off `rdk query`) has to hold this connection, and they must all do it the
// same way.
//
// They no longer compete for it. Central used to keep one session per node and
// close the previous with 4001, so this module arbitrated between local
// processes with a file lock; the loser sat idle, and a slipped hand-off turned
// into a supersede loop. Central now holds every session for a node at once, so
// each process simply connects and announces itself. An old Central still sends
// 4001, and the client treats that as "retry in a few minutes" rather than
// giving up — see REPLACED_RETRY_MS in client.ts.

import { getWsClient, type RdkWebSocketClient } from './client.js';
import { announceWs, clearWs, type RdkApp } from './ws-presence.js';

/** How often presence is refreshed (must stay under ws-presence's STALE_MS). */
const PRESENCE_TICK_MS = 30_000;

export interface WsSessionOptions {
  /** Which surface this is, so other processes can name it. */
  app?: RdkApp;
  /** Overrides the default label for `app`. */
  label?: string;
  /** Diagnostics sink. Defaults to silence — the desktop surfaces state via
   *  getStatus(), the CLI prints to stderr. */
  log?: (message: string) => void;
}

export interface WsSession {
  /** True when this process has a live socket to Central right now. */
  isConnected(): boolean;
  /** Close this process's socket and withdraw its presence. */
  stop(): void;
}

/**
 * Open and hold this process's Central connection.
 *
 * Returns null when this machine has no usable node identity (not signed in, or
 * an offline `local-` node).
 */
export function startWsSession(opts: WsSessionOptions = {}): WsSession | null {
  const client = getWsClient();
  if (!client) return null;

  const log = opts.log ?? (() => {});
  const app = opts.app ?? 'unknown';
  let stopped = false;

  const announce = (connected: boolean) => announceWs({ app, label: opts.label, connected });

  client.on('connected', () => {
    announce(true);
    log('connected to RDK Central — serving content');
  });
  client.on('disconnected', ({ code, reason }: { code: number; reason: string }) => {
    announce(false);
    if (code !== 1000) log(`disconnected from RDK Central (${code})${reason ? ': ' + reason : ''}`);
  });

  announce(false);
  void client.connect();

  // Refresh presence, and keep trying if we are not connected. The client has
  // its own backoff; connect() no-ops when a socket already exists, so this is
  // only a backstop against a client that stopped retrying for any reason.
  const tick = setInterval(() => {
    if (stopped) return;
    announce(client.isConnected());
    if (!client.isConnected()) void client.connect();
  }, PRESENCE_TICK_MS);
  if (typeof tick.unref === 'function') tick.unref();

  return {
    isConnected: () => client.isConnected(),
    stop: () => {
      stopped = true;
      clearInterval(tick);
      client.disconnect();
      clearWs();
    },
  };
}

/**
 * Hold the Central connection for the duration of one short-lived command (e.g.
 * `rdk query`), so a user who hasn't installed the always-on service can still
 * retrieve their own content.
 *
 * Waits (briefly) for the socket to come up before running `fn`, because Central
 * fetches content synchronously while answering the query.
 */
export async function withWsConnection<T>(
  fn: () => Promise<T>,
  opts: WsSessionOptions & { readyTimeoutMs?: number } = {},
): Promise<T> {
  const session = startWsSession({ app: 'cli', ...opts });
  if (!session) return fn();

  try {
    await waitForConnection(session, opts.readyTimeoutMs ?? 5_000);
    return await fn();
  } finally {
    session.stop();
  }
}

async function waitForConnection(session: WsSession, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!session.isConnected() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export type { RdkWebSocketClient };
