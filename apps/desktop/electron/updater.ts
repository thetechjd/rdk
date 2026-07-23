// electron/updater.ts
//
// Desktop update flow (v1): prompt → confirm → download → hand off to the installer.
//
// Why not electron-updater (yet): the repo's GitHub releases mix CLI tags (v*) and
// desktop tags (desktop-v*), so electron-updater's "latest release" feed resolution
// picks the wrong release; and silent mac auto-update additionally requires signed +
// notarized builds. This v1 works TODAY, unsigned, on all three platforms:
//   1. throttled check of the GitHub releases API for the newest desktop-v* tag,
//   2. native dialog: "RDK X.Y.Z is available — update now?",
//   3. on confirm: download the right installer for this platform to a temp dir,
//   4. open it (NSIS wizard on Windows, mounted .dmg on macOS) and quit so it can
//      replace the app. Linux .deb/AppImage users get the browser download instead.
// Upgrade path to silent updates: a dedicated release feed + mac signing, then swap
// this module for electron-updater with the same dialog UX.

import { app, dialog, shell, type BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';

const REPO = 'thetechjd/rdk';
const TAG_PREFIX = 'desktop-v';
const CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const cachePath = () => path.join(app.getPath('userData'), 'update-check.json');

interface ReleaseAsset { name: string; browser_download_url: string }
interface Release { tag_name: string; assets: ReleaseAsset[]; html_url: string }

function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Newest desktop-v* release, or null. */
async function fetchLatestDesktopRelease(): Promise<Release | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=15`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const releases = (await res.json()) as Release[];
  const desktop = releases
    .filter((r) => r.tag_name?.startsWith(TAG_PREFIX))
    .sort((a, b) => cmpVersion(b.tag_name.slice(TAG_PREFIX.length), a.tag_name.slice(TAG_PREFIX.length)));
  return desktop[0] ?? null;
}

/** The installer asset for this platform, or null (deb is offered via browser). */
function pickAsset(release: Release): ReleaseAsset | null {
  const byExt = (ext: string) => release.assets.find((a) => a.name.toLowerCase().endsWith(ext)) ?? null;
  if (process.platform === 'win32') return byExt('.exe');
  if (process.platform === 'darwin') return byExt('.dmg');
  return byExt('.appimage');
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

/**
 * Check for a newer desktop release (throttled to once/day unless `force`), and if one
 * exists walk the user through prompt → confirm → download → installer hand-off.
 */
export async function checkForUpdates(win: BrowserWindow | null, opts: { force?: boolean } = {}): Promise<void> {
  if (!app.isPackaged && !opts.force) return; // dev runs update via git, not installers

  // Throttle background checks; explicit "check now" always runs.
  try {
    if (!opts.force) {
      const c = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as { checkedAt?: number };
      if (c.checkedAt && Date.now() - c.checkedAt < CHECK_TTL_MS) return;
    }
  } catch { /* no cache yet */ }
  try { fs.writeFileSync(cachePath(), JSON.stringify({ checkedAt: Date.now() })); } catch { /* non-fatal */ }

  let release: Release | null = null;
  try { release = await fetchLatestDesktopRelease(); } catch { return; }
  if (!release) return;

  const latest = release.tag_name.slice(TAG_PREFIX.length);
  const current = app.getVersion();
  if (cmpVersion(latest, current) <= 0) {
    if (opts.force && win) {
      await dialog.showMessageBox(win, { type: 'info', message: `RDK ${current} is up to date.` });
    }
    return;
  }

  const asset = pickAsset(release);
  const { response } = await dialog.showMessageBox(win ?? undefined as never, {
    type: 'info',
    title: 'Update available',
    message: `RDK ${latest} is available (you have ${current}).`,
    detail: asset
      ? 'The installer will download and open; the app will close so it can be replaced.'
      : 'Your platform updates via the package/download page.',
    buttons: asset ? ['Update now', 'Later'] : ['Open download page', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;

  if (!asset) {
    void shell.openExternal(release.html_url);
    return;
  }

  try {
    const dest = path.join(os.tmpdir(), asset.name);
    await downloadTo(asset.browser_download_url, dest);
    if (process.platform === 'linux') fs.chmodSync(dest, 0o755);
    if (process.platform === 'win32' || process.platform === 'darwin') {
      // NSIS wizard / mounted .dmg — hand off and quit so the app can be replaced.
      await shell.openPath(dest);
      app.quit();
    } else {
      // AppImage: we can't safely replace a running image — reveal the new one.
      shell.showItemInFolder(dest);
      if (win) {
        await dialog.showMessageBox(win, {
          type: 'info',
          message: `Downloaded ${asset.name}.`,
          detail: 'Replace your current AppImage with this file (the app must be closed first).',
        });
      }
    }
  } catch (e) {
    // Download failed — fall back to the release page in the browser.
    console.error('[updater] download failed:', e);
    void shell.openExternal(release.html_url);
  }
}
