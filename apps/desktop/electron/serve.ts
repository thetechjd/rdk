// electron/serve.ts
// Headless node: the desktop app's own equivalent of `rdk mcp:serve`, so the
// background service and Claude Desktop can run RDK without the CLI installed.
//
// Nothing but those launches may import this module: loading it under
// ELECTRON_RUN_AS_NODE starts the server.
//
// Runs two ways, both from the app's own executable:
//  - as plain Node (ELECTRON_RUN_AS_NODE=1 <exe> serve.js) — the service on
//    macOS/Linux and the MCP server Claude Desktop spawns. Nothing here may
//    import 'electron': in that mode it resolves to a path string, not the API.
//  - inside the Electron main process (<exe> --rdk-serve) — the Windows service,
//    because Task Scheduler cannot set the environment variable above.
// See serve-launch.ts for how each launch is built.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { RdkApp } from '@rdk/node/ws/ws-presence';
import { SERVE_AS_ENV } from './serve-launch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same bundled model main.ts uses: packaged → <resources>/models (this file is
// <resources>/app.asar/out/main/serve.js), dev → apps/desktop/build/models.
function bundledModelsDir(): string {
  return __dirname.includes(`${path.sep}app.asar${path.sep}`)
    ? path.resolve(__dirname, '../../../models')
    : path.resolve(__dirname, '../../build/models');
}

export async function runServe(app: RdkApp): Promise<void> {
  const models = bundledModelsDir();
  if (!process.env.RDK_MODELS_DIR && fs.existsSync(path.join(models, 'Xenova'))) {
    process.env.RDK_MODELS_DIR = models;
  }

  const { configExists, loadConfig } = await import('@rdk/node/config');
  if (!configExists()) {
    console.error('RDK is not set up on this machine yet. Open the RDK app and finish setup, then try again.');
    process.exit(1);
  }
  const config = loadConfig();

  const { startHttpServer, startMcpServer } = await import('@retrodeck/mcp');
  const { LocalStore } = await import('@rdk/core');
  const boundPort: number = await (startHttpServer as (c: unknown, s: unknown) => Promise<number>)(config, new LocalStore());

  console.error('RDK MCP server starting...');
  if (boundPort > 0) console.error(`  .well-known: http://localhost:${boundPort}/.well-known/mcp.json`);
  console.error(`  Node:        ${config.nodeId}`);

  // Holding this socket is what makes this node's chunks retrievable.
  const { startWsSession } = await import('@rdk/node/ws/ownership');
  const ownership = startWsSession({ app, log: msg => console.error(`  · ${msg}`) });

  const shutdown = (): void => {
    ownership?.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await startMcpServer();
}

if (process.env.ELECTRON_RUN_AS_NODE) {
  runServe(process.env[SERVE_AS_ENV] === 'service' ? 'service' : 'mcp').catch((e: unknown) => {
    console.error((e as Error).message || String(e));
    process.exit(1);
  });
}
