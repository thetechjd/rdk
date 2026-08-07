// packages/rdk-node/src/ws/client.ts
// Persistent WebSocket connection to RDK Central. Runs only within mcp:serve.

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { loadConfig } from '../config.js';
import { dispatchCommand } from './handlers/index.js';
import type { WsMessage } from './protocol.js';

// Inline ANSI "dim" so @rdk/node carries no dependency on the CLI's theme module.
// These strings go to stderr (stdout is the MCP JSON-RPC channel).
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

/**
 * How long to wait before retrying after Central closes us with 4001.
 *
 * 4001 means "another session replaced you" — only an OLD Central sends it;
 * current Central holds every session for a node at once. So this is the
 * compatibility path, and it has to satisfy two things at the same time:
 * never give up (the instance that displaced us may exit, and then somebody has
 * to serve), and never ping-pong (two instances kicking each other on a short
 * timer is what once put 208 connections in five minutes onto Central from a
 * single node). Minutes apart, jittered, does both.
 */
const REPLACED_RETRY_MS = 5 * 60_000;

export class RdkWebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stabilityTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private jwt: string | null = null;
  private pendingAcks = new Map<string, (response: unknown) => void>();

  constructor(
    private readonly wsUrl: string,
    private readonly apiBaseUrl: string,  // e.g. https://rdk.retrodeck.ai
    private readonly apiKey: string,      // long-lived API key from config
    /** Overridable so tests can exercise the 4001 path without waiting minutes. */
    private readonly replacedRetryMs: number = REPLACED_RETRY_MS,
  ) {
    super();
    // Safety net: an EventEmitter that emits 'error' with no listener throws and
    // would crash the whole mcp:serve process. Live sync is best-effort, so never
    // let a Central connection problem be fatal.
    this.on('error', () => {});
  }

  /**
   * Exchange the long-lived API key for a short-lived JWT, exactly as
   * `rdk vault:sync` does. WebSocket auth is verified once at upgrade, so a
   * fresh JWT per connect/reconnect is sufficient — no mid-connection refresh.
   */
  private async fetchJwt(): Promise<string> {
    const res = await fetch(`${this.apiBaseUrl}/api/v1/nodes/auth`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`auth exchange failed: HTTP ${res.status}`);
    }
    const data = await res.json() as { jwtToken?: string };
    if (!data.jwtToken) {
      throw new Error('auth exchange returned no jwtToken');
    }
    return data.jwtToken;
  }

  async connect(): Promise<void> {
    if (this.ws) return;
    // connect() is an explicit request to own the session again. A previous
    // replacement close (4001) disables automatic reconnect for that ownership
    // tenure, but must not permanently poison later manual takeovers.
    this.shouldReconnect = true;

    // Fetch a fresh JWT, then open the socket with it. Both steps are guarded so
    // connect() never rejects — callers (mcp:serve, scheduleReconnect) fire-and-forget.
    try {
      this.jwt = await this.fetchJwt();
      this.ws = new WebSocket(this.wsUrl, {
        headers: { Authorization: `Bearer ${this.jwt}` },
      });
    } catch (e) {
      console.error(dim(`  · RDK Central auth failed: ${(e as Error).message}`));
      this.emit('error', e);
      if (this.shouldReconnect) this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      // Resetting the backoff the instant the socket opens means a connection
      // that opens and immediately drops — exactly what an overloaded Central
      // does — restarts at 2s forever and never escalates. Only a connection
      // that SURVIVES counts as success.
      if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
      this.stabilityTimer = setTimeout(() => { this.reconnectAttempt = 0; }, 30_000);
      this.startHeartbeat();
      this.emit('connected');
      console.error(dim('  ✓ connected to RDK Central'));
    });

    this.ws.on('message', (raw) => {
      this.handleMessage(raw.toString()).catch(() => {});
    });

    this.ws.on('close', (code, reason) => {
      this.stopHeartbeat();
      // The socket did not survive its probation, so the pending reset must not
      // fire — this close is what escalates the backoff instead of restarting it.
      if (this.stabilityTimer) { clearTimeout(this.stabilityTimer); this.stabilityTimer = null; }
      this.ws = null;
      this.emit('disconnected', { code, reason: reason.toString() });
      // 4001 = "replaced": this Central still allows one session per node, so
      // another rdk instance displaced us. Not reconnecting AT ALL was the old
      // behaviour, and it stranded the node whenever that other instance later
      // exited — nothing was left to reopen the socket, so the node stayed
      // silently unreachable for the rest of its life. Retry, but far enough
      // apart that two instances cannot ping-pong.
      if (code === 4001) {
        if (this.shouldReconnect) {
          console.error(dim('  · RDK Central: another instance is serving this node — will retry'));
          this.scheduleReconnect(this.replacedRetryMs);
        }
        return;
      }
      if (this.shouldReconnect) this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      // Best-effort: log, then let the 'close' handler reconnect with backoff.
      // Never re-emit a bare 'error' — that would crash mcp:serve if unhandled.
      console.error(dim(`  · RDK Central connection error: ${(err as Error).message}`));
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.stabilityTimer) { clearTimeout(this.stabilityTimer); this.stabilityTimer = null; }
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000, 'shutdown');
      this.ws = null;
    }
  }

  send(msg: WsMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * @param fixedDelayMs Use this delay instead of the escalating backoff, and
   * do not count the attempt. A 4001 is not a failure to connect — escalating
   * on it would eventually push a healthy standby out to the 60s ceiling and
   * keep it there.
   */
  private scheduleReconnect(fixedDelayMs?: number): void {
    // Both the auth-failure path and the close handler call this, so without
    // clearing first a single failed attempt can leave two live timers — and the
    // overwritten handle can never be cancelled. Each extra timer is another
    // full auth on Central, whose cost is O(nodes) in bcrypt, so duplicates
    // multiply into a storm the fleet cannot recover from.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    const backoffMs = fixedDelayMs ?? Math.min(60_000, 2_000 * Math.pow(2, this.reconnectAttempt));
    // Jitter: without it every node in the fleet retries on the same schedule
    // after a shared outage and they arrive as one thundering herd.
    const delayMs = Math.round(backoffMs * (0.5 + Math.random() / 2));
    if (fixedDelayMs === undefined) this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      console.error(dim('  reconnecting to RDK Central...'));
      void this.connect();
    }, delayMs);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'node.heartbeat' });
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw) as Record<string, unknown>; } catch { return; }

    if (msg['type'] === 'ready') {
      this.emit('ready', msg['data']);
      return;
    }

    if (msg['type'] === 'ack' || msg['type'] === 'error') {
      const replyTo = msg['replyTo'] as string | undefined;
      if (replyTo) {
        const handler = this.pendingAcks.get(replyTo);
        if (handler) {
          this.pendingAcks.delete(replyTo);
          handler(msg);
        }
      }
      return;
    }

    if (typeof msg['type'] === 'string' && msg['type'].startsWith('command.')) {
      // Log to stderr (stdout is the MCP protocol) so the device service logs
      // show exactly what command/ID/data arrived and whether it succeeded.
      console.error(`[rdk ws] received ${msg['type']} id=${msg['id']} data=${JSON.stringify(msg['data'])}`);
      try {
        const result = await dispatchCommand(msg as { type: string; id: string; data: unknown });
        console.error(`[rdk ws] completed ${msg['type']} id=${msg['id']}`);
        this.send({ type: 'ack', replyTo: msg['id'] as string, data: result });
      } catch (e) {
        console.error(`[rdk ws] failed ${msg['type']} id=${msg['id']}: ${(e as Error).message}`);
        this.send({
          type: 'error',
          replyTo: msg['id'] as string,
          error: { code: 'COMMAND_FAILED', message: (e as Error).message },
        });
      }
    }
  }
}

// Singleton — created once per mcp:serve process
let client: RdkWebSocketClient | null = null;

/**
 * Drop the cached client so the next `getWsClient()` reads the config again.
 *
 * The client captures nodeId and apiKey at construction. Registering a node
 * changes BOTH, so without this the process keeps authenticating as the
 * `local-` identity it just replaced — and stays offline for its whole life.
 */
export function resetWsClient(): void {
  try { client?.disconnect(); } catch { /* already gone */ }
  client = null;
}

export function getWsClient(): RdkWebSocketClient | null {
  if (client) return client;
  try {
    const config = loadConfig();
    if (config.nodeId.startsWith('local-')) return null; // offline mode — no WS
    const wsUrl = config.centralApiUrl.replace(/^http/, 'ws') + '/ws/internal/node';
    client = new RdkWebSocketClient(wsUrl, config.centralApiUrl, config.apiKey);
    return client;
  } catch {
    return null;
  }
}
