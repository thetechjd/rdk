// packages/rdk-node/src/service/linux.ts

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import type { LaunchSpec, ServiceAdapter } from './index.js';

const execAsync = promisify(exec);

const UNIT_NAME = 'rdk.service';
const UNIT_DIR  = path.join(os.homedir(), '.config', 'systemd', 'user');
const UNIT_PATH = path.join(UNIT_DIR, UNIT_NAME);

function buildUnit({ command, args, env = {} }: LaunchSpec, logDir: string): string {
  // systemd ExecStart supports double-quoted tokens; quoting every token keeps
  // absolute paths with spaces intact.
  const execStart = [command, ...args].map(tok => `"${tok}"`).join(' ');
  const extraEnv = Object.entries(env).map(([k, v]) => `\nEnvironment="${k}=${v}"`).join('');
  return `[Unit]
Description=RDK — Retrieval Development Kit node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=10
StandardOutput=append:${path.join(logDir, 'rdk.out.log')}
StandardError=append:${path.join(logDir, 'rdk.err.log')}
Environment="PATH=/usr/local/bin:/usr/bin:/bin"${extraEnv}

[Install]
WantedBy=default.target
`;
}

export const LinuxAdapter: ServiceAdapter = {
  async install(launch) {
    const logDir  = path.join(os.homedir(), '.rdk', 'logs');
    await fs.mkdir(logDir, { recursive: true });
    await fs.mkdir(UNIT_DIR, { recursive: true });

    const unitContent = buildUnit(launch, logDir);
    await fs.writeFile(UNIT_PATH, unitContent, 'utf8');

    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    execSync(`systemctl --user enable ${UNIT_NAME}`, { stdio: 'pipe' });
    execSync(`systemctl --user start ${UNIT_NAME}`, { stdio: 'pipe' });
  },

  async uninstall() {
    try { execSync(`systemctl --user stop ${UNIT_NAME}`,    { stdio: 'ignore' }); } catch {}
    try { execSync(`systemctl --user disable ${UNIT_NAME}`, { stdio: 'ignore' }); } catch {}
    try { await fs.unlink(UNIT_PATH); } catch {}
    try { execSync('systemctl --user daemon-reload',        { stdio: 'ignore' }); } catch {}
  },

  async start() {
    execSync(`systemctl --user start ${UNIT_NAME}`, { stdio: 'inherit' });
  },

  async stop() {
    execSync(`systemctl --user stop ${UNIT_NAME}`, { stdio: 'inherit' });
  },

  async status() {
    const installed = await fs.access(UNIT_PATH).then(() => true).catch(() => false);
    if (!installed) {
      return { installed: false, running: false };
    }

    try {
      const { stdout } = await execAsync(
        `systemctl --user show ${UNIT_NAME} --property=ActiveState,MainPID,Result`,
      );
      const activeState = stdout.match(/ActiveState=(\w+)/)?.[1];
      const mainPid     = stdout.match(/MainPID=(\d+)/)?.[1];
      const result      = stdout.match(/Result=(\w+)/)?.[1];

      const running   = activeState === 'active';
      const pid       = mainPid && mainPid !== '0' ? parseInt(mainPid, 10) : undefined;
      const lastError = result && result !== 'success' ? `Last result: ${result}` : undefined;

      return { installed: true, running, pid, lastError };
    } catch {
      return { installed: true, running: false };
    }
  },
};
