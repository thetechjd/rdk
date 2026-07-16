// electron/platform.ts
// Every OS-specific decision lives behind an explicit switch so Windows support
// is "fill in a known branch", never "hunt for scattered Unix assumptions"
// (see docs/feasibility-report.md §4). Paths always go through path.join /
// os.homedir() / app.getPath — never hardcoded separators or `~`.

import { app, shell } from 'electron';
import path from 'path';

export const PLATFORM = process.platform;

/** Auto-start on boot/login. Electron's own login-item settings cover mac + win;
 *  Linux has no universal API so we surface it as unsupported here and route the
 *  user to Settings → "install as service" (systemd user unit) instead. */
export function autoStartSupported(): boolean {
  switch (PLATFORM) {
    case 'darwin':
    case 'win32':
      return true;
    case 'linux':
      return false; // use the systemd service path instead
    default:
      return false;
  }
}

export function setAutoStart(enabled: boolean): void {
  switch (PLATFORM) {
    case 'darwin':
    case 'win32':
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
      return;
    case 'linux':
      throw new Error('AUTO_START_UNSUPPORTED_LINUX'); // handled by caller → systemd service
    default:
      throw new Error('AUTO_START_UNSUPPORTED_PLATFORM');
  }
}

/** OS-service install (auto-start before/without GUI login). Reuses the CLI's
 *  service adapters conceptually; the desktop prefers setLoginItemSettings for
 *  darwin/win and only needs a real service on Linux (systemd user unit). */
export function serviceInstallSupported(): boolean {
  switch (PLATFORM) {
    case 'darwin':
    case 'linux':
      return true;
    case 'win32':
      return true; // Task Scheduler adapter exists (service/windows.ts)
    default:
      return false;
  }
}

/** Reveal a file/folder in the OS file manager (Finder / Explorer / Files). */
export function revealInFileManager(target: string): void {
  // shell.showItemInFolder is cross-platform; normalize the path first.
  shell.showItemInFolder(path.normalize(target));
}

/** Default vault location guess, per platform, all via os.homedir(). */
export function defaultVaultGuess(): string {
  const home = app.getPath('home');
  switch (PLATFORM) {
    case 'darwin':
    case 'linux':
    case 'win32':
      return path.join(home, 'Documents', 'ObsidianVault');
    default:
      return path.join(home, 'ObsidianVault');
  }
}

/** Human label for the auto-start affordance, so the UI can explain unavailability. */
export function autoStartLabel(): string {
  switch (PLATFORM) {
    case 'darwin':
      return 'Start RDK when I log in (macOS login item)';
    case 'win32':
      return 'Start RDK when I sign in (Windows startup)';
    case 'linux':
      return 'Auto-start on Linux uses a systemd user service (Settings → Node)';
    default:
      return 'Auto-start is not supported on this platform yet';
  }
}
