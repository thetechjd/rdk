// electron/serve-launch.ts
// How to start this app's headless node (serve.ts) from outside the app — for
// the OS service and for Claude Desktop's MCP config. Every launch points at the
// desktop's own executable, so neither needs the rdk CLI. Must not import
// 'electron' — serve.ts imports it and runs as plain Node.

import path from 'path';
import { fileURLToPath } from 'url';
import type { LaunchSpec } from '@rdk/node/service';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Env var the service launch sets so the ws presence names it correctly. */
export const SERVE_AS_ENV = 'RDK_SERVE_AS';

/** argv flag main.ts checks to run serve.ts in-process (the Windows service). */
export const SERVE_FLAG = '--rdk-serve';

/**
 * - 'service': the OS auto-start unit.
 * - 'mcp':     the server Claude Desktop spawns over stdio.
 */
export function serveLaunch(as: 'service' | 'mcp'): LaunchSpec {
  // Task Scheduler cannot set ELECTRON_RUN_AS_NODE, so the Windows service
  // starts the app normally with a flag and main.ts runs serve.ts windowless.
  if (as === 'service' && process.platform === 'win32') {
    return { command: process.execPath, args: [SERVE_FLAG] };
  }

  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };
  if (as === 'service') env[SERVE_AS_ENV] = 'service';

  // An AppImage mounts at a new /tmp/.mount_* path on every run, so neither
  // execPath nor serve.js has a stable path. Launch the .AppImage itself and
  // find serve.js relative to wherever it mounted this time.
  const appImage = process.env.APPIMAGE;
  if (appImage) {
    const bootstrap =
      "const p=require('path');" +
      "import(require('url').pathToFileURL(p.join(p.dirname(process.execPath),'resources','app.asar','out','main','serve.js')).href)";
    return { command: appImage, args: ['-e', bootstrap], env };
  }

  // Installed builds (.app, .deb, Windows installer) live at a fixed path that
  // updates replace in place, so the absolute serve.js path stays valid.
  return { command: process.execPath, args: [path.join(__dirname, 'serve.js')], env };
}
