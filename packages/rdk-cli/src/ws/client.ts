// packages/rdk-cli/src/ws/client.ts
// Persistent WebSocket connection to RDK Central. Runs only within mcp:serve.

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { loadConfig } from '../config.js';
import { dispatchCommand } from './handlers/index.js';
import { t } from '../theme.js';
import type { WsMessage } from './protocol.js';

export class RdkWebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private jwt: string | null = null;
  private pendingAcks = new Map<string, (response: unknown) => void>();

  constructor(
    private readonly wsUrl: string,
    private readonly apiBaseUrl: string,  // e.g. https://rdk.retrodeck.ai
    private readonly apiKey: string,      // long-lived API key from config
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

    // Fetch a fresh JWT, then open the socket with it. Both steps are guarded so
    // connect() never rejects — callers (mcp:serve, scheduleReconnect) fire-and-forget.
    try {
      this.jwt = await this.fetchJwt();
      this.ws = new WebSocket(this.wsUrl, {
        headers: { Authorization: `Bearer ${this.jwt}` },
      });
    } catch (e) {
      console.error(t.dim(`  · RDK Central auth failed: ${(e as Error).message}`));
      this.emit('error', e);
      if (this.shouldReconnect) this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.startHeartbeat();
      this.emit('connected');
      console.error(t.dim('  ✓ connected to RDK Central'));
    });

    this.ws.on('message', (raw) => {
      this.handleMessage(raw.toString()).catch(() => {});
    });

    this.ws.on('close', (code, reason) => {
      this.stopHeartbeat();
      this.ws = null;
      this.emit('disconnected', { code, reason: reason.toString() });
      if (this.shouldReconnect) this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      // Best-effort: log, then let the 'close' handler reconnect with backoff.
      // Never re-emit a bare 'error' — that would crash mcp:serve if unhandled.
      console.error(t.dim(`  · RDK Central connection error: ${(err as Error).message}`));
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
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

  private scheduleReconnect(): void {
    const delayMs = Math.min(60_000, 2_000 * Math.pow(2, this.reconnectAttempt));
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      console.error(t.dim(`  reconnecting to RDK Central (attempt ${this.reconnectAttempt})...`));
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
      try {
        const result = await dispatchCommand(msg as { type: string; id: string; data: unknown });
        this.send({ type: 'ack', replyTo: msg['id'] as string, data: result });
      } catch (e) {
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
