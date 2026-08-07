import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

import { RdkWebSocketClient } from '../src/ws/client.js';

/**
 * What happens when Central still allows one session per node.
 *
 * Central now holds every session for a node at once, so 4001 ("replaced")
 * should never arrive again — but a client upgraded before the server, or
 * pointed at an older deployment, will still meet it. The old behaviour was to
 * stop reconnecting forever, which stranded the node the moment the instance
 * that displaced it exited: nothing was left to reopen the socket, and the node
 * sat silently unreachable for the rest of its life.
 *
 * It must also not swing the other way. Two instances retrying on a short timer
 * is what once put 208 connections in five minutes onto Central from one node.
 */
describe('a Central that still replaces sessions', () => {
  let server: Server;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * A single-session Central: it accepts a socket, then closes it with 4001 as
   * if another instance had taken over.
   */
  async function singleSessionCentral(): Promise<{ url: string; api: string; connects: () => number }> {
    let connects = 0;
    server = createServer((req, res) => {
      if (req.url === '/api/v1/nodes/auth') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jwtToken: 'test-jwt' }));
        return;
      }
      res.writeHead(404).end();
    });

    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket as never, head, (ws) => {
        connects += 1;
        ws.close(4001, 'replaced');
      });
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `ws://127.0.0.1:${port}/ws/internal/node`,
      api: `http://127.0.0.1:${port}`,
      connects: () => connects,
    };
  }

  it('retries after being replaced instead of giving up forever', async () => {
    const central = await singleSessionCentral();
    // Real delay is minutes; the constructor takes it so this can be seconds.
    const client = new RdkWebSocketClient(central.url, central.api, 'key', 300);

    await client.connect();
    // First connect, then the retry — proof the client did not disable itself.
    await waitFor(() => central.connects() >= 2, 5_000);

    expect(central.connects()).toBeGreaterThanOrEqual(2);
    client.disconnect();
  });

  it('waits between retries rather than hammering the server', async () => {
    const central = await singleSessionCentral();
    const client = new RdkWebSocketClient(central.url, central.api, 'key', 2_000);

    await client.connect();
    await waitFor(() => central.connects() >= 1, 3_000);
    // With the retry delay at 2s (jittered to 1–2s), a second attempt cannot
    // have landed yet. A client that reconnected immediately would ping-pong
    // with the instance that displaced it.
    await new Promise((r) => setTimeout(r, 500));

    expect(central.connects()).toBe(1);
    client.disconnect();
  });

  it('stops retrying once disconnect() is called', async () => {
    const central = await singleSessionCentral();
    const client = new RdkWebSocketClient(central.url, central.api, 'key', 300);

    await client.connect();
    await waitFor(() => central.connects() >= 1, 3_000);
    client.disconnect();

    const seen = central.connects();
    await new Promise((r) => setTimeout(r, 900));
    // Shutting down means shutting down — a timer surviving disconnect() would
    // reconnect a process that is trying to exit.
    expect(central.connects()).toBe(seen);
  });
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}
