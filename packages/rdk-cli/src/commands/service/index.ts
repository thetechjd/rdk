// packages/rdk-cli/src/commands/service/index.ts

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { t, mark } from '../../theme.js';
import { getAdapter, detectPlatform, resolveLaunch } from './platform.js';

const PID_FILE = path.join(os.homedir(), '.rdk', 'mcp-serve.pid');

/**
 * Returns the pid of a live detached mcp:serve, or null. Clears a stale pid
 * file if the process is gone.
 */
export function detachedPid(): number | null {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!pid) return null;
    process.kill(pid, 0); // throws ESRCH if not running
    return pid;
  } catch {
    try { fs.unlinkSync(PID_FILE); } catch { /* already gone */ }
    return null;
  }
}

/**
 * Start the MCP server in the background for this boot only (no auto-start
 * hook installed). Uses the same absolute launch spec as the service adapters,
 * so it works regardless of how RDK was installed. Idempotent: a second call
 * while one is already running is a no-op with a notice.
 */
export async function startDetached(): Promise<void> {
  const existing = detachedPid();
  if (existing) {
    console.error(t.dim(`  RDK MCP server is already running in the background (pid: ${existing}).`));
    console.error(t.dim('  Stop it with: rdk mcp:serve --stop'));
    return;
  }

  const logDir = path.join(os.homedir(), '.rdk', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, 'rdk.out.log'), 'a');
  const err = fs.openSync(path.join(logDir, 'rdk.err.log'), 'a');

  // Child runs the normal FOREGROUND serve (no --detach) so it holds the
  // WebSocket to Central exactly like an attached run. Absolute launch spec
  // means it survives a minimal PATH and the parent terminal closing.
  const { command, args } = resolveLaunch('mcp:serve');
  const child = spawn(command, args, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
  });
  child.unref();

  if (child.pid) fs.writeFileSync(PID_FILE, String(child.pid), { mode: 0o600 });

  console.error('');
  console.error(t.green(`  ${mark.ok()} RDK MCP server started (pid: ${child.pid})`));
  console.error(t.dim(`  Logs:   ${path.join(logDir, 'rdk.out.log')}`));
  console.error(t.dim('  Status: rdk mcp:serve --status'));
  console.error(t.dim('  Stop:   rdk mcp:serve --stop'));
  console.error(t.dim('  Runs until you reboot. Enable auto-start on boot: rdk service:install'));
  console.error('');
}

/** Stop a detached mcp:serve started with --detach (or init's "run now"). */
export async function stopDetached(): Promise<void> {
  const pid = detachedPid();
  if (!pid) {
    console.error(t.dim('  RDK MCP server is not running in the background.'));
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already exiting */ }
  try { fs.unlinkSync(PID_FILE); } catch { /* already gone */ }
  console.error(t.green(`  ${mark.ok()} RDK MCP server stopped (pid: ${pid})`));
}

/** Report whether a detached mcp:serve is running. */
export async function detachedStatus(): Promise<void> {
  const pid = detachedPid();
  console.error(pid
    ? t.green(`  ● RDK MCP server is running in the background (pid: ${pid})`)
    : t.dim('  ○ RDK MCP server is not running in the background'));
}

export async function serviceInstall(): Promise<void> {
  const platform = detectPlatform();
  if (platform === 'unsupported') {
    console.error(t.error('  Unsupported platform.'));
    console.error(t.dim('  Supported: macOS, Linux (systemd), Windows.'));
    return;
  }

  console.error('');
  console.error(t.heading(`  Installing RDK auto-start (${platform})`));
  console.error('');

  try {
    const adapter = await getAdapter();
    await adapter.install();
    console.error('');
    console.error(t.green(`  ${mark.ok()} RDK is now running in the background`));
    console.error(t.green(`  ${mark.ok()} RDK will auto-start when your computer boots`));
    console.error('');
    console.error(t.dim('  Check status: rdk service:status'));
    console.error(t.dim('  Stop:         rdk service:stop'));
    console.error(t.dim('  Uninstall:    rdk service:uninstall'));
    console.error('');
  } catch (e) {
    console.error(t.error(`  Install failed: ${(e as Error).message}`));
  }
}

export async function serviceUninstall(opts: { yes?: boolean } = {}): Promise<void> {
  if (!opts.yes) {
    const { confirm } = await import('../../prompts.js');
    const confirmed = await confirm({
      message: 'Stop RDK and remove auto-start?',
      default: false,
    });
    if (!confirmed) return;
  }

  try {
    const adapter = await getAdapter();
    await adapter.uninstall();
    console.error('');
    console.error(t.green(`  ${mark.ok()} RDK auto-start removed`));
    console.error('');
  } catch (e) {
    console.error(t.error((e as Error).message));
  }
}

export async function serviceStart(): Promise<void> {
  try {
    const adapter = await getAdapter();
    await adapter.start();
    console.error(t.green(`  ${mark.ok()} RDK started`));
  } catch (e) {
    console.error(t.error((e as Error).message));
  }
}

export async function serviceStop(): Promise<void> {
  try {
    const adapter = await getAdapter();
    await adapter.stop();
    console.error(t.green(`  ${mark.ok()} RDK stopped`));
  } catch (e) {
    console.error(t.error((e as Error).message));
  }
}

export async function serviceStatus(): Promise<void> {
  try {
    const adapter = await getAdapter();
    const status  = await adapter.status();

    console.error('');
    console.error(t.heading('  RDK Service Status'));
    console.error('');

    const installLabel = status.installed
      ? t.green('installed')
      : t.dim('not installed');
    console.error(`  ${t.dim('auto-start:')}  ${installLabel}`);

    const runLabel = status.running
      ? t.green(`running (pid: ${status.pid ?? '?'})`)
      : t.dim('stopped');
    console.error(`  ${t.dim('state:')}       ${runLabel}`);

    if (status.lastError) {
      console.error(`  ${t.dim('last error:')}  ${t.warn(status.lastError)}`);
    }
    console.error('');

    if (!status.installed) {
      console.error(t.dim('  Enable auto-start: rdk service:install'));
      console.error('');
    }
  } catch (e) {
    console.error(t.error((e as Error).message));
  }
}
