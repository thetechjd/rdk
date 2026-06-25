// packages/rdk-cli/src/open-url.ts
// Minimal cross-platform "open this URL in the default browser".
//
// Replaces the `open` npm package: esbuild bundles it to CJS, where its
// top-level `fileURLToPath(import.meta.url)` resolves to `undefined` and throws
// at module load — crashing any command that opens a link (topup, account:upgrade).
//
// Fire-and-forget. Callers should also print the URL so a headless/SSH session
// (where no browser launches) still gets the link.

import { spawn } from 'child_process';

export function openUrl(url: string): void {
  const { command, args } =
    process.platform === 'darwin'
      ? { command: 'open', args: [url] }
      : process.platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'start', '', url] }
        : { command: 'xdg-open', args: [url] };
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // No browser/launcher available — the caller prints the URL as fallback.
  }
}
