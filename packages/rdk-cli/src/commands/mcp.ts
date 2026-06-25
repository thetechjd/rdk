// packages/rdk-cli/src/commands/mcp.ts
import { isInstalled } from '../require-dep.js';
import { loadConfig, updateConfig } from '../config.js';
import { t, mark } from '../theme.js';

export async function mcpServe(opts: { port?: number; detach?: boolean; stop?: boolean; status?: boolean } = {}): Promise<void> {
  // Run-mode controls run before the foreground serve. These manage a
  // background ("detached") serve via ~/.rdk/mcp-serve.pid.
  if (opts.stop)   { const { stopDetached }   = await import('./service/index.js'); return stopDetached(); }
  if (opts.status) { const { detachedStatus } = await import('./service/index.js'); return detachedStatus(); }
  if (opts.detach) { const { startDetached }  = await import('./service/index.js'); return startDetached(); }

  // Check the MCP SDK dep before stdio transport starts — never prompt or install mid-session.
  // Use the /server subpath: v1.29.0+ dropped the root index.js, only subpaths exist.
  // @retrodeck/mcp is bundled into the CLI, so we only gate on the on-demand SDK here.
  if (!await isInstalled('@modelcontextprotocol/sdk/server')) {
    console.error('MCP SDK not installed. Run: rdk network:join');
    process.exit(1);
  }

  const config = loadConfig();

  // ── Email verification gate ──────────────────────────────────────────────
  if (config.retrodeckUserId && config.retrodeckApiUrl && !config.emailVerified) {
    try {
      const res = await fetch(
        `${config.retrodeckApiUrl}/api/v1/auth/verification-status`,
        { headers: { Authorization: `Bearer ${config.retrodeckAccessToken}` } },
      );
      if (res.ok) {
        const data = await res.json() as { verified: boolean };
        if (data.verified) {
          updateConfig({ emailVerified: true });
        } else {
          console.error('');
          console.error(`  ${mark.warn()} ${t.warn('Email not verified')}`);
          console.error(t.dim('  Check your inbox and click the verification link.'));
          console.error(t.dim('  You must verify your email before running the MCP server.'));
          console.error(t.dim('  Once verified, run: rdk mcp:serve'));
          console.error('');
          process.exit(1);
        }
      }
    } catch {
      // Network failure — fail open, don't block on connectivity
    }
  }

  const { startHttpServer } = await import('@retrodeck/mcp');
  const { LocalStore } = await import('@rdk/core');
  const store = new LocalStore();
  // If --port was passed, use it as the preferred starting port
  const configWithPort = opts.port ? { ...config, mcpPort: opts.port } : config;
  const boundPort: number = await (startHttpServer as (c: unknown, s: unknown) => Promise<number>)(configWithPort, store);

  console.error(t.green('RDK MCP server starting...'));
  if (boundPort > 0) {
    console.error(t.dim(`  .well-known: http://localhost:${boundPort}/.well-known/mcp.json`));
  }
  console.error(t.dim(`  Node:        ${config.nodeId}`));
  console.error(t.dim(`  Domain:      ${config.domain}`));

  // ── WebSocket connection to RDK Central ─────────────────────────────────
  // Only ONE process per node may hold the Central WS (Central kicks duplicates
  // with 4001). When the always-on service AND Claude Desktop both run
  // mcp:serve, a lock decides who owns the connection; the others serve their
  // MCP tools without opening a competing socket. The owner heartbeats the
  // lock; if it dies, another instance takes over on its next tick.
  const { getWsClient } = await import('../ws/client.js');
  const { wsHeldByOther, claimWs, releaseWs } = await import('../ws/ws-lock.js');
  const ws = getWsClient();
  let wsOwner = false;
  let wsOwnerTick: ReturnType<typeof setInterval> | undefined;

  if (ws) {
    ws.on('connected', () => {
      console.error(t.dim('  ✓ live sync active'));
    });
    ws.on('disconnected', ({ code, reason }: { code: number; reason: string }) => {
      if (code !== 1000) {
        console.error(t.dim(`  · disconnected from RDK Central (${code})${reason ? ': ' + reason : ''}`));
      }
    });

    const ensureOwner = () => {
      if (wsOwner) { claimWs(); return; }          // refresh our heartbeat
      if (wsHeldByOther()) return;                  // another instance owns it — tools-only
      wsOwner = true;
      claimWs();
      console.error(t.dim('  ✓ holding the RDK Central connection for this node'));
      ws.connect();
    };
    ensureOwner();
    if (!wsOwner) {
      console.error(t.dim('  · another rdk mcp:serve holds the RDK Central connection — serving tools only'));
    }
    wsOwnerTick = setInterval(ensureOwner, 30_000);
    if (typeof wsOwnerTick.unref === 'function') wsOwnerTick.unref();
  }

  // ── Clean shutdown ───────────────────────────────────────────────────────
  const shutdown = () => {
    if (wsOwnerTick) clearInterval(wsOwnerTick);
    if (wsOwner) { ws?.disconnect(); releaseWs(); }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const { startMcpServer } = await import('@retrodeck/mcp');
  await startMcpServer();
}

export async function mcpValidate(): Promise<void> {
  const config = loadConfig();
  const port = config.mcpPort ?? 4242;
  try {
    const res = await fetch(`http://localhost:${port}/.well-known/mcp.json`);
    if (res.ok) {
      console.log(`${mark.ok()} .well-known/mcp.json valid`);
      console.log(JSON.stringify(await res.json(), null, 2));
    } else {
      console.log(`${mark.error()} HTTP ${res.status}`);
    }
  } catch {
    console.log(`${mark.error()} ${t.error('MCP server not running. Start with: rdk mcp:serve')}`);
  }
}

export async function mcpTest(): Promise<void> {
  console.log(t.heading('MCP server test:'));
  await mcpValidate();
}
