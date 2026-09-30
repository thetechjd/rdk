// packages/rdk-node/src/service/macos.ts

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import type { LaunchSpec, ServiceAdapter } from './index.js';

const execAsync = promisify(exec);

const LABEL = 'ai.retrodeck.rdk';
const PLIST_PATH = path.join(
  os.homedir(),
  'Library',
  'LaunchAgents',
  `${LABEL}.plist`,
);

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildPlist({ command, args, env = {} }: LaunchSpec, logDir: string): string {
  const programArgs = [command, ...args]
    .map(a => `      <string>${xmlEscape(a)}</string>`)
    .join('\n');
  const extraEnv = Object.entries(env)
    .map(([k, v]) => `\n      <key>${xmlEscape(k)}</key>\n      <string>${xmlEscape(v)}</string>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>

    <key>StandardOutPath</key>
    <string>${path.join(logDir, 'rdk.out.log')}</string>

    <key>StandardErrorPath</key>
    <string>${path.join(logDir, 'rdk.err.log')}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
      <key>HOME</key>
      <string>${os.homedir()}</string>${extraEnv}
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>
  </dict>
</plist>`;
}

export const MacOSAdapter: ServiceAdapter = {
  async install(launch) {
    const logDir = path.join(os.homedir(), '.rdk', 'logs');
    await fs.mkdir(logDir, { recursive: true });
    await fs.mkdir(path.dirname(PLIST_PATH), { recursive: true });

    const plistContent = buildPlist(launch, logDir);
    await fs.writeFile(PLIST_PATH, plistContent, 'utf8');

    try {
      execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'ignore' });
    } catch { /* not loaded yet, that's fine */ }

    execSync(`launchctl load "${PLIST_PATH}"`, { stdio: 'pipe' });
  },

  async uninstall() {
    try {
      execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'ignore' });
    } catch { /* may not be loaded */ }
    try {
      await fs.unlink(PLIST_PATH);
    } catch { /* may not exist */ }
  },

  async start() {
    execSync(`launchctl start ${LABEL}`, { stdio: 'inherit' });
  },

  async stop() {
    execSync(`launchctl stop ${LABEL}`, { stdio: 'inherit' });
  },

  async status() {
    const installed = await fs.access(PLIST_PATH).then(() => true).catch(() => false);
    if (!installed) {
      return { installed: false, running: false };
    }

    try {
      const { stdout } = await execAsync(`launchctl list ${LABEL}`);
      const pidMatch   = stdout.match(/"PID"\s*=\s*(\d+);/);
      const errorMatch = stdout.match(/"LastExitStatus"\s*=\s*(\d+);/);
      const pid        = pidMatch ? parseInt(pidMatch[1], 10) : undefined;
      const lastError  = errorMatch && errorMatch[1] !== '0'
        ? `Last exit status: ${errorMatch[1]}`
        : undefined;
      return { installed: true, running: !!pid, pid, lastError };
    } catch {
      return { installed: true, running: false };
    }
  },
};
