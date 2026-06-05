// packages/rdk-cli/src/commands/mcp.ts
import { requireDeps } from '../require-dep.js';
import { loadConfig, updateConfig } from '../config.js';
import { t, mark } from '../theme.js';

export async function mcpServe(opts: { port?: number }): Promise<void> {
  const ready = await requireDeps(
    ['@rdk/mcp', '@modelcontextprotocol/sdk', '@xenova/transformers'],
    { label: 'MCP server components' },
  );
  if (!ready) {
    console.log(t.warn('Run rdk network:join to install MCP components first.'));
    return;
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
          console.log('');
          console.log(`  ${mark.warn()} ${t.warn('Email not verified')}`);
          console.log(t.dim('  Check your inbox and click the verification link.'));
          console.log(t.dim('  You must verify your email before running the MCP server.'));
          console.log('');

          const { confirm } = await import('../prompts.js');
          const resend = await confirm({ message: 'Resend verification email?', default: true });

          if (resend) {
            try {
              await fetch(
                `${config.retrodeckApiUrl}/api/v1/auth/resend-verification`,
                {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${config.retrodeckAccessToken}` },
                },
              );
              console.log(`  ${mark.ok()} ${t.body('Verification email sent')}`);
            } catch {}
          }

          console.log('');
          console.log(t.dim('  Once verified, run: rdk mcp:serve'));
          console.log('');
          return;
        }
      }
    } catch {
      // Network failure — fail open, don't block on connectivity
    }
  }

  const port = opts.port ?? config.mcpPort ?? 3000;

  const { startHttpServer } = await import('@rdk/mcp');
  const { LocalStore } = await import('@rdk/core');
  const store = new LocalStore();
  startHttpServer(config as unknown as Parameters<typeof startHttpServer>[0], store);

  console.error(t.green('RDK MCP server starting...'));
  console.error(t.dim(`  .well-known: http://localhost:${port}/.well-known/mcp.json`));
  console.error(t.dim(`  Node:        ${config.nodeId}`));
  console.error(t.dim(`  Domain:      ${config.domain}`));

  const { startMcpServer } = await import('@rdk/mcp');
  await startMcpServer();
}

export async function mcpValidate(): Promise<void> {
  const config = loadConfig();
  const port = config.mcpPort ?? 3000;
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
