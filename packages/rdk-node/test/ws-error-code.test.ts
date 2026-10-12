import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

import { RdkWebSocketClient, errorCode } from '../src/ws/client.js';
import { saveConfig } from '../src/config.js';

/**
 * SPEC 02 Phase 5 item 9 (RDK_PL_00A C2): a handler's thrown `.code` reaches
 * Central as the reply's `error.code`, because Central decides between
 * "failed for good" and "re-queue" on it. COMMAND_FAILED is only the fallback.
 */

describe('errorCode', () => {
  it('forwards a string .code and falls back to COMMAND_FAILED', () => {
    expect(errorCode(Object.assign(new Error('x'), { code: 'content_hash_mismatch' }))).toBe('content_hash_mismatch');
    expect(errorCode(Object.assign(new Error('x'), { code: 'rate_limited' }))).toBe('rate_limited');
    expect(errorCode(new Error('plain'))).toBe('COMMAND_FAILED');
    expect(errorCode(Object.assign(new Error('x'), { code: 42 }))).toBe('COMMAND_FAILED');
    expect(errorCode('thrown string')).toBe('COMMAND_FAILED');
    expect(errorCode(null)).toBe('COMMAND_FAILED');
  });

  it("never forwards Central's own transport codes", () => {
    for (const code of ['COMMAND_TIMEOUT', 'TRANSPORT_ERROR', 'NODE_DISCONNECTED']) {
      expect(errorCode(Object.assign(new Error('x'), { code }))).toBe('COMMAND_FAILED');
    }
  });
});

describe('WS command replies', () => {
  let server: Server;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends the partner handler code in error.code, and COMMAND_FAILED for an unknown command', async () => {
    // A linked node with no partners: every partner job is partner_not_linked.
    saveConfig({
      nodeId: 'node-ws', apiKey: 'rdk_live_ws', centralApiUrl: 'http://127.0.0.1:1',
      plan: 'free', vaultAdapter: 'filesystem', vaultPath: '', domain: 'general',
      walletChain: 'base', mcpPort: 4242, createdAt: new Date().toISOString(),
    });

    const replies: Array<Record<string, unknown>> = [];
    let socket: WebSocket | null = null;
    server = createServer((req, res) => {
      if (req.url === '/api/v1/nodes/auth') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jwtToken: 'jwt' }));
        return;
      }
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, sock, head) => {
      wss.handleUpgrade(req, sock as never, head, (ws) => {
        socket = ws;
        ws.on('message', (raw) => replies.push(JSON.parse(raw.toString())));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const client = new RdkWebSocketClient(`ws://127.0.0.1:${port}/ws/internal/node`, `http://127.0.0.1:${port}`, 'key');
    await client.connect();
    await waitFor(() => socket !== null && client.isConnected(), 3_000);

    socket!.send(JSON.stringify({
      type: 'command.partner_job', id: 'cmd_1',
      data: { jobId: 'job_1', partnerId: 'parlayledger', jobType: 'ping', payload: {}, issuedAt: new Date().toISOString() },
    }));
    socket!.send(JSON.stringify({ type: 'command.not_a_thing', id: 'cmd_2', data: {} }));
    await waitFor(() => replies.filter((r) => r.type === 'error').length >= 2, 3_000);
    client.disconnect();

    const byId = Object.fromEntries(replies.filter((r) => r.type === 'error').map((r) => [r.replyTo, r]));
    expect(byId.cmd_1).toMatchObject({ type: 'error', replyTo: 'cmd_1', error: { code: 'partner_not_linked' } });
    expect(byId.cmd_2).toMatchObject({ type: 'error', replyTo: 'cmd_2', error: { code: 'COMMAND_FAILED' } });
  });
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}
