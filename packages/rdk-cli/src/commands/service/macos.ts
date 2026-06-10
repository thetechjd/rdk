// packages/rdk-cli/src/commands/service/macos.ts

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const LABEL = 'ai.retrodeck.rdk';
const PLIST_PATH = path.join(
  os.homedir(),
  'Library',
  'LaunchAgents',
  `${LABEL}.plist`,
);

function buildPlist(rdkPath: string, logDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${rdkPath}</string>
      <string>mcp:serve</string>
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
      <string>${os.homedir()}</string>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>
  </dict>
</plist>`;
}

async function findRdkBinary(): Promise<string> {
  try {
    const { stdout } = await execAsync('which rdk');
    return stdout.trim();
  } catch {
    throw new Error('Cannot find rdk binary. Is RDK installed and in your PATH?');
  }
}

export const MacOSAdapter = {
  async install() {
    const rdkPath = await findRdkBinary();
    const logDir = path.join(os.homedir(), '.rdk', 'logs');
    await fs.mkdir(logDir, { recursive: true });
    await fs.mkdir(path.dirname(PLIST_PATH), { recursive: true });

    const plistContent = buildPlist(rdkPath, logDir);
    await fs.writeFile(PLIST_PATH, plistContent, 'utf8');

    try {
      execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'ignore' });
    } catch { /* not loaded yet, that's fine */ }

    execSync(`launchctl load "${PLIST_PATH}"`, { stdio: 'inherit' });
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
