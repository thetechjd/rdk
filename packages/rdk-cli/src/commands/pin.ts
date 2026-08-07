// packages/rdk-cli/src/commands/pin.ts
//
// Pinning keeps a document answerable on the network while this node is
// offline. It is the only content RDK Central stores, so it is billed monthly
// as rent per MB — every command here says the size out loud before or after
// it acts, so nobody accumulates a bill they didn't see coming.

import { loadConfig } from '../config.js';
import { t, mark, divider } from '../theme.js';
import type { DocumentSummary } from '@rdk/core';

/** Rent is quoted per MB, so show MB — but not "0.0 MB" for a small note. */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function client() {
  const config = loadConfig();
  if (!config.centralApiUrl || !config.apiKey) {
    console.log(t.error('  This node is not connected to the network.'));
    console.log(t.dim('  Run: rdk network:join'));
    return null;
  }
  const { CentralClient } = await import('@rdk/node');
  return new CentralClient({ centralApiUrl: config.centralApiUrl, apiKey: config.apiKey });
}

/**
 * Resolve what the user typed to exactly one indexed document.
 *
 * Refuses to guess between several matches: pinning the wrong document costs
 * real money every month until someone notices.
 */
async function resolveDocument(target: string): Promise<DocumentSummary | null> {
  const { LocalStore } = await import('@rdk/core');
  const store = new LocalStore();
  let matches: DocumentSummary[];
  try {
    const path = await import('path');
    // Try the absolute path first so `rdk pin ./notes/spec.md` from any
    // directory hits the same row the indexer wrote.
    matches = store.findDocuments(path.resolve(target));
    if (matches.length === 0) matches = store.findDocuments(target);
  } finally {
    store.close();
  }

  if (matches.length === 0) {
    console.log(t.error(`  No indexed document matches "${target}".`));
    console.log(t.dim('  List what is indexed with: rdk pins --available'));
    return null;
  }
  if (matches.length > 1) {
    console.log(t.warn(`  "${target}" matches ${matches.length} documents:`));
    console.log('');
    for (const d of matches.slice(0, 10)) {
      console.log(`  ${t.body(d.title)}  ${t.dim(d.hash.slice(0, 12))}  ${t.dim(d.sourcePath ?? '')}`);
    }
    console.log('');
    console.log(t.dim('  Pin one by its hash prefix.'));
    return null;
  }
  return matches[0];
}

/** rdk pin <pathOrTitleOrHash> — keep a document available while this node is offline. */
export async function pin(target: string): Promise<void> {
  const api = await client();
  if (!api) return;

  const doc = await resolveDocument(target);
  if (!doc) return;

  // Central refuses this too, but catching it locally saves a round trip and
  // explains the fix in terms of the user's own vault.
  if (!doc.isPublic && !doc.isEncrypted) {
    console.log(t.error('  This document is private but stored unencrypted, so pinning it'));
    console.log(t.error('  would place it on RDK Central in the clear.'));
    console.log(t.dim('  Set a vault key (rdk vault init) and re-index it, then pin.'));
    return;
  }

  const ora = (await import('ora')).default;
  const spinner = ora(`Pinning ${doc.title}...`).start();
  try {
    const summary = await api.pinDocument(doc.hash);
    spinner.succeed(`Pinned ${t.body(doc.title)} ${t.dim(`(${formatSize(summary.sizeBytes)})`)}`);
    console.log(t.dim('  It stays answerable on the network while this node is offline.'));
    console.log(t.dim('  Billed monthly as pin rent alongside your subscription.'));
  } catch (e) {
    spinner.fail((e as Error).message);
  }
}

/** rdk unpin <pathOrTitleOrHash> — stop paying rent; the file itself is untouched. */
export async function unpin(target: string): Promise<void> {
  const api = await client();
  if (!api) return;

  const doc = await resolveDocument(target);
  if (!doc) return;

  const ora = (await import('ora')).default;
  const spinner = ora(`Unpinning ${doc.title}...`).start();
  try {
    await api.unpinDocument(doc.hash);
    spinner.succeed(`Unpinned ${t.body(doc.title)}`);
    console.log(t.dim('  Your copy is untouched — it is only answerable while this node is online.'));
  } catch (e) {
    spinner.fail((e as Error).message);
  }
}

/** rdk pins [--available] — what is pinned (and what could be). */
export async function pins(opts: { available?: boolean } = {}): Promise<void> {
  if (opts.available) return listAvailable();

  const api = await client();
  if (!api) return;

  try {
    const { pins: rows, totalBytes } = await api.listPins();
    console.log(t.heading('\nPinned documents\n'));
    if (rows.length === 0) {
      console.log(t.dim('  Nothing pinned. Pin a document with: rdk pin <file>'));
      console.log('');
      return;
    }
    for (const p of rows) {
      const visibility = p.isPublic ? 'public' : 'private';
      console.log(
        `  ${mark.ok()} ${t.body(p.title ?? p.documentHash.slice(0, 12))}` +
        `  ${t.dim(visibility.padEnd(7))}  ${t.dim(formatSize(p.sizeBytes).padStart(9))}` +
        `  ${t.dim(p.documentHash.slice(0, 12))}`,
      );
    }
    console.log(divider(40));
    console.log(`  ${rows.length} pinned · ${t.body(formatSize(totalBytes))} of rented storage`);
    console.log(t.dim('  Billed monthly per MB alongside your subscription.'));
    console.log('');
  } catch (e) {
    console.log(t.error(`  Could not list pins: ${(e as Error).message}`));
  }
}

/** Indexed documents on this node, marked with whether they are pinned. */
async function listAvailable(): Promise<void> {
  const { LocalStore } = await import('@rdk/core');
  const store = new LocalStore();
  let docs: DocumentSummary[];
  try {
    docs = store.listDocuments();
  } finally {
    store.close();
  }

  if (docs.length === 0) {
    console.log(t.warn('\n  Nothing indexed yet. Run: rdk vault:index\n'));
    return;
  }

  // Pin state comes from Central; without a connection, still list the
  // documents rather than failing outright.
  let pinned = new Set<string>();
  const api = await client();
  if (api) {
    try {
      pinned = new Set(await api.pinnedHashes(docs.map((d) => d.hash)));
    } catch {
      console.log(t.dim('  (could not reach the network — pin state not shown)'));
    }
  }

  console.log(t.heading('\nIndexed documents\n'));
  for (const d of docs) {
    const flag = pinned.has(d.hash) ? mark.ok() : ' ';
    console.log(
      `  ${flag} ${t.body(d.title)}  ${t.dim((d.isPublic ? 'public' : 'private').padEnd(7))}` +
      `  ${t.dim(formatSize(d.sizeBytes).padStart(9))}  ${t.dim(d.hash.slice(0, 12))}`,
    );
  }
  console.log('');
  console.log(t.dim(`  ${mark.ok()} = pinned. Pin one with: rdk pin <file>`));
  console.log('');
}
