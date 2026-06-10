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
  private pendingAcks = new Map<string, (response: unknown) => void>();

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {
    super();
  }

  connect(): void {
    if (this.ws) return;

    this.ws = new WebSocket(this.url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

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
      this.emit('error', err);
      // close handler fires next; nothing to do here
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
      this.connect();
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
    client = new RdkWebSocketClient(wsUrl, config.apiKey);
    return client;
  } catch {
    return null;
  }
}
