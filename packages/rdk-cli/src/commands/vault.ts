// packages/rdk-cli/src/commands/vault.ts
import { loadConfig, updateConfig } from '../config.js';
import { requireDeps } from '../require-dep.js';
import { loadAdapter } from '../load-adapter.js';
import { t, mark, divider } from '../theme.js';

export async function vaultConnect(adapter: string, vaultPath?: string): Promise<void> {
  const ora = (await import('ora')).default;
  const adapterKey = `@retrodeck/adapter-${adapter}`;
  console.log('');
  const ready = await requireDeps([adapterKey], { label: `Vault adapter for ${adapter}` });
  if (!ready) return;

  const config = loadConfig();
  const resolvedPath = vaultPath ?? config.vaultPath;

  const spinner = ora(`Connecting ${adapter} vault at ${resolvedPath}...`).start();
  try {
    const adapterInst = await loadAdapter(adapterKey);
    await adapterInst.connect({ vaultPath: resolvedPath, domain: config.domain, vaultKeyHex: config.vaultKeyHex });
    const meta = adapterInst.getMetadata();
    spinner.succeed(`Connected — ${meta.documentCount} documents found`);
    console.log(t.dim('  Run rdk vault:index to index them'));
  } catch (e) {
    spinner.fail((e as Error).message);
  }
}

export async function vaultIndex(opts: { force?: boolean; isPublic?: boolean }): Promise<void> {
  const ora = (await import('ora')).default;
  const config = loadConfig();
  const adapterKey = `@retrodeck/adapter-${config.vaultAdapter}`;

  const ready = await requireDeps(
    [adapterKey, '@xenova/transformers'],
    { label: 'Indexing components' },
  );
  if (!ready) return;

  const isPublic = opts.isPublic ?? false;
  const spinner = ora(`Indexing vault (${config.vaultAdapter})...`).start();
  try {
    const adapter = await loadAdapter(adapterKey);
    await adapter.connect({
      vaultPath: config.vaultPath,
      domain: config.domain,
      publicFolders: config.publicFolders ?? [],
      vaultKeyHex: config.vaultKeyHex,
    });

    const indexFn = opts.force ? adapter.indexAll : adapter.indexChanged;
    if (typeof indexFn !== 'function') {
      throw new Error(`Vault adapter "${config.vaultAdapter}" is missing index support — reinstall it: rdk vault:connect ${config.vaultAdapter}`);
    }

    const result = opts.force
      ? await adapter.indexAll({ isPublic })
      : await adapter.indexChanged(
          new Date(Date.now() - 24 * 60 * 60 * 1000),
          { isPublic },
        );

    if (!result || typeof result.chunksIndexed !== 'number') {
      throw new Error(`Vault adapter "${config.vaultAdapter}" returned no result — it may be an outdated version. Reinstall: rdk vault:connect ${config.vaultAdapter}`);
    }

    spinner.succeed(`Indexed ${result.chunksIndexed} chunks`);
    console.log(t.dim(`  ${result.chunksIndexed} chunks indexed (${isPublic ? 'public' : 'private by default'})`));
    if (!isPublic) {
      console.log(t.dim('  Files in folders marked public via vault:set-public are indexed as public.'));
    }

    if (result.errors.length > 0) {
      console.log(t.warn(`\n${result.errors.length} errors:`));
      result.errors.slice(0, 5).forEach((e: string) => console.log(t.dim(`  ${e}`)));
    }
  } catch (err: unknown) {
    spinner.fail((err as Error).message);
    process.exit(1);
  }
}

/** Version history for a vault file's document series (live + superseded). */
/**
 * Fill in metadata that older versions of RDK never recorded, for chunks that
 * are already indexed:
 *
 *  - `summary` — only produced when an LLM was wired into the indexer, so in
 *    practice no chunk had one. It's the one part of a public chunk Central may
 *    hold, and therefore the only thing that can answer while this node is
 *    offline.
 *  - `docTitle` — the document's own title. Without it, every surface guessed
 *    at one by splitting the chunk title on ' — ', which yields the file stem.
 *
 * Touched chunks are re-queued for sync; run `rdk vault:sync` afterwards (or let
 * the background sync pick them up). Private chunks are stored encrypted, so
 * their summaries can't be recomputed here — and aren't synced anyway.
 */
export async function vaultBackfill(): Promise<void> {
  const ora = (await import('ora')).default;
  const fs = await import('fs');
  const path = await import('path');
  const { LocalStore, extractDocTitle, extractiveSummary, docTitleFromChunkTitle } = await import('@rdk/core');

  const spinner = ora('Scanning indexed chunks...').start();
  const store = new LocalStore();
  try {
    const chunks = store.getAllChunks().filter(c => !c.supersededAt);

    // One file read per document, not per chunk.
    const docTitleByPath = new Map<string, string | undefined>();
    const readDocTitle = (sourcePath: string): string | undefined => {
      if (docTitleByPath.has(sourcePath)) return docTitleByPath.get(sourcePath);
      let title: string | undefined;
      try {
        if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()) {
          const raw = fs.readFileSync(sourcePath, 'utf-8');
          title = extractDocTitle(raw, path.basename(sourcePath, path.extname(sourcePath)));
        }
      } catch { /* unreadable / moved / a URL — fall back below */ }
      docTitleByPath.set(sourcePath, title);
      return title;
    };

    let summaries = 0;
    let titles = 0;
    for (const chunk of chunks) {
      const fields: { summary?: string; docTitle?: string } = {};

      // Public chunks store plaintext; private ones store ciphertext, which
      // would summarize to noise.
      if (chunk.isPublic && !chunk.summary?.trim()) {
        const summary = extractiveSummary(chunk.content);
        if (summary) { fields.summary = summary; summaries++; }
      }

      // rowToChunk already falls back to the legacy title split in memory, so
      // only persist when we can do better — or when nothing is stored at all.
      const fromFile = chunk.sourcePath ? readDocTitle(chunk.sourcePath) : undefined;
      const docTitle = fromFile ?? docTitleFromChunkTitle(chunk.title);
      if (docTitle && docTitle !== chunk.docTitle) { fields.docTitle = docTitle; titles++; }

      if (Object.keys(fields).length > 0) store.backfillMetadata(chunk.id, fields);
    }

    spinner.succeed(
      `Backfilled ${summaries} summary(ies) and ${titles} document title(s) across ${chunks.length} chunk(s)`,
    );
    if (summaries + titles > 0) {
      console.log(t.dim('  Run `rdk vault:sync` to push the updated metadata to the network.'));
    }
  } catch (e) {
    spinner.fail((e as Error).message);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

export async function vaultVersions(filePath: string): Promise<void> {
  const path = await import('path');
  const { LocalStore } = await import('@rdk/core');
  const store = new LocalStore();
  const abs = path.resolve(filePath);
  const versions = store.getVersions(abs);
  store.close();

  if (!versions.length) {
    console.log(t.warn(`No indexed versions found for ${filePath}`));
    console.log(t.dim('  (history is tracked per source file — index it first)'));
    return;
  }

  console.log(t.heading(`\nVersions of ${path.basename(abs)}\n`));
  for (const v of versions) {
    const state = v.isPublic ? 'public' : v.isLocalOnly ? 'local' : 'private';
    const status = v.supersededAt ? t.dim('superseded') : t.body('live');
    console.log(`  v${v.version ?? 1}  ${state.padEnd(7)}  ${status}  ${t.dim(v.createdAt.toISOString().slice(0, 10))}  ${t.dim(v.id.slice(0, 12))}`);
  }
  console.log('');
}

export async function vaultStatus(): Promise<void> {
  const config = loadConfig();
  const { LocalStore } = await import('@rdk/core');
  const store = new LocalStore();
  const stats = store.getStats();
  store.close();

  console.log(t.heading('\nVault Status'));
  console.log(divider(40));
  console.log(`${t.dim('adapter:')}     ${t.body(config.vaultAdapter)}`);
  console.log(`${t.dim('path:')}        ${t.body(config.vaultPath)}`);
  console.log(`${t.dim('domain:')}      ${t.body(config.domain)}`);
  console.log('');
  console.log(`${t.dim('private chunks:')}  ${t.body(stats.privateChunks.toLocaleString())}  ${t.dim('(encrypted on network)')}`);
  console.log(`${t.dim('public chunks:')}   ${t.body(stats.publicChunks.toLocaleString())}  ${t.dim('(plaintext on network)')}`);
  console.log(`${t.dim('unsynced:')}        ${t.body(stats.unsyncedChunks.toLocaleString())}`);
}

export async function vaultSync(opts: { force?: boolean; verify?: boolean } = {}): Promise<void> {
  const ora = (await import('ora')).default;
  const config = loadConfig();

  if (!config.centralApiUrl || !config.apiKey) {
    console.log(t.warn('Not connected to network. Run: rdk network:join'));
    return;
  }

  if (config.nodeId.startsWith('local-') || config.apiKey.startsWith('rdk_local_')) {
    console.log(t.warn('This node is in offline mode and cannot sync to RDK Central.'));
    console.log(t.dim('  Run: rdk network:join'));
    return;
  }

  const spinner = ora('Authenticating with RDK Central...').start();
  try {
    const authRes = await fetch(`${config.centralApiUrl}/api/v1/nodes/auth`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!authRes.ok) throw new Error(`Auth failed: HTTP ${authRes.status}`);
    const { jwtToken } = await authRes.json() as { jwtToken: string };

    const { LocalStore } = await import('@rdk/core');
    const store = new LocalStore();

    // Reconcile first: re-queue any locally-"synced" chunks the network no
    // longer stores (hard-deleted on re-index, or owned by an orphaned node).
    if (opts.verify) {
      spinner.text = 'Reconciling with the network...';
      try {
        const { SyncService } = await import('@rdk/node/sync-service');
        const sync = new SyncService(
          { enabled: false, intervalMinutes: 0, centralApiUrl: config.centralApiUrl, centralApiKey: config.apiKey, log: () => {} },
          store,
        );
        const { checked, missing } = await sync.verify();
        spinner.text = `Reconciled ${checked} chunk(s) — ${missing} re-queued for sync...`;
      } catch (e) {
        spinner.text = `Reconcile skipped (${(e as Error).message}) — syncing...`;
      }
    }

    if (opts.force) {
      const reset = store.resetSyncState();
      spinner.text = `Re-syncing all ${reset} chunk(s) to network...`;
    } else {
      spinner.text = 'Syncing chunks to network...';
    }

    // Public AND private chunks sync (embedding + metadata); only content stays on-node.
    const chunks = store.getUnsyncedChunks(100);

    if (!chunks.length) {
      store.close();
      spinner.succeed('Nothing to sync — all chunks already on network');
      return;
    }

    let synced = 0;
    let failed = 0;

    for (const chunk of chunks) {
      const embedding = store.getEmbedding(chunk.id);
      if (!embedding) continue;

      try {
        const res = await fetch(`${config.centralApiUrl}/api/v1/chunks/sync`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${jwtToken}`,
          },
          body: JSON.stringify({
            chunks: [{
              chunkHash: chunk.id,
              title: chunk.title,                                  // sent for public AND private
              docTitle: chunk.docTitle,                            // names the document in the Files view
              summary: chunk.isPublic ? chunk.summary : undefined, // private summary stays on-node
              domain: chunk.domain ?? config.domain,
              categories: chunk.categories,
              embedding: Array.from(embedding),
              chunkTokens: Math.ceil(chunk.content.length / 4),
              isPublic: chunk.isPublic,
              isEncrypted: !chunk.isPublic,  // derived boolean (private ⟺ encrypted) — never a SQLite int
              freshnessAt: chunk.updatedAt.toISOString(),
              // Version-series metadata, matching the indexer's own sync payload —
              // without these a `vault:sync` would blank out what indexing set.
              sourcePath: chunk.sourcePath,
              sourceAdapter: chunk.sourceAdapter,
              supersedesHash: chunk.supersedes,
              version: chunk.version ?? 1,
            }],
          }),
          signal: AbortSignal.timeout(10000),
        });

        if (res.ok) {
          // A 200 can still skip this chunk (plan limit, bad embedding). Trust
          // the body: only mark synced if central actually persisted it.
          const result = await res.json().catch(() => null) as
            | { synced?: number; acceptedHashes?: string[] } | null;
          const accepted = Array.isArray(result?.acceptedHashes)
            ? result!.acceptedHashes.includes(chunk.id)
            : (result?.synced ?? 1) > 0; // old central: infer from synced count
          if (accepted) {
            store.markSynced(chunk.id);
            synced++;
          } else {
            failed++;
          }
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }

    store.close();
    const failNote = failed > 0 ? t.warn(` (${failed} failed)`) : '';
    spinner.succeed(`Synced ${synced} chunk${synced !== 1 ? 's' : ''} to network${failNote}`);
  } catch (err) {
    spinner.fail((err as Error).message);
  }
}

export async function vaultPublish(opts: { path?: string; yes?: boolean } = {}): Promise<void> {
  const { LocalStore } = await import('@rdk/core');
  const store = new LocalStore();

  // Per-path scope: publish just one file's chunks instead of the whole vault.
  if (opts.path) {
    const path = await import('path');
    const abs = path.resolve(opts.path);
    const chunks = store.getVersions(abs).filter(c => !c.supersededAt && !c.isPublic && !c.isLocalOnly);
    if (!chunks.length) {
      console.log(t.dim(`No private chunks found for ${opts.path}.`));
      store.close();
      return;
    }
    console.log(t.warn(`Publishing ${chunks.length} chunk(s) of ${path.basename(abs)} — public content is versioned; unpublish stops serving but copies already saved elsewhere cannot be recalled.`));
    if (!opts.yes) {
      const { confirm } = await import('../prompts.js');
      if (!(await confirm({ message: 'Publish now?', default: false }))) { store.close(); return; }
    }
    // markAllPublic is vault-wide; per-path goes chunk-by-chunk.
    for (const c of chunks) {
      const embedding = store.getEmbedding(c.id);
      if (embedding) store.saveChunk({ ...c, isPublic: true, isEncrypted: false, syncedAt: undefined }, embedding);
    }
    store.close();
    console.log(t.body(`Published ${chunks.length} chunk(s).`));
    await vaultSync();
    return;
  }

  // Whole-vault publish is a big, one-way action — confirm it (was silent).
  const stats = store.getStats();
  if (!opts.yes && stats.privateChunks > 0) {
    console.log(t.warn(`This publishes ALL ${stats.privateChunks} private chunk(s) to the public network.`));
    console.log(t.dim('  Public content earns tips and is versioned; unpublish stops serving a chunk,'));
    console.log(t.dim('  but copies other nodes already saved cannot be recalled.'));
    const { confirm } = await import('../prompts.js');
    if (!(await confirm({ message: 'Publish everything now?', default: false }))) { store.close(); return; }
  }

  const changed = store.markAllPublic();
  store.close();

  if (changed === 0) {
    console.log(t.dim('All chunks are already public.'));
  } else {
    console.log(t.body(`Marked ${changed} chunk${changed !== 1 ? 's' : ''} as public.`));
  }

  await vaultSync();
}

/**
 * Delete a file's chunks (or one chunk by id) from the index — locally AND on
 * central. Public rows RETIRE on central (stop serving; earnings history kept).
 * The vault file on disk is never touched.
 */
export async function vaultDelete(target: string, opts: { yes?: boolean } = {}): Promise<void> {
  const path = await import('path');
  const { LocalStore } = await import('@rdk/core');
  const config = loadConfig();
  const store = new LocalStore();

  const isChunkId = /^[0-9a-f]{64}$/i.test(target);
  const chunks = isChunkId
    ? [store.getChunk(target)].filter((c): c is NonNullable<typeof c> => !!c)
    : store.getVersions(path.resolve(target)).filter(c => !c.supersededAt);

  if (!chunks.length) {
    console.log(t.warn('Nothing indexed matches that path/chunk id.'));
    store.close();
    return;
  }

  if (!opts.yes) {
    const { confirm } = await import('../prompts.js');
    if (!(await confirm({ message: `Delete ${chunks.length} chunk(s) from the index (file on disk untouched)?`, default: false }))) {
      store.close();
      return;
    }
  }

  // Central cleanup first (needs the rows' ids), then local.
  let centralOk = 0;
  if (config.centralApiUrl && config.apiKey) {
    const { SyncService } = await import('@rdk/node/sync-service');
    const sync = new SyncService(
      { enabled: false, intervalMinutes: 0, centralApiUrl: config.centralApiUrl, centralApiKey: config.apiKey, log: () => {} },
      store,
    );
    for (const c of chunks) {
      if (!c.isLocalOnly && (await sync.deleteOnCentral(c.id))) centralOk++;
    }
  }
  for (const c of chunks) store.deleteChunk(c.id);
  store.close();

  console.log(t.body(`Deleted ${chunks.length} chunk(s) locally` + (centralOk ? `; ${centralOk} removed/retired on the network.` : '.')));
}

export async function vaultSearch(query: string, opts: { topK?: number }): Promise<void> {
  const ora = (await import('ora')).default;
  const ready = await requireDeps(['@xenova/transformers'], { label: 'Embedding model' });
  if (!ready) return;

  const { LocalStore, LocalEmbeddingModel, decrypt, keyFromHex } = await import('@rdk/core');
  const config = loadConfig();
  const vaultKey = config.vaultKeyHex ? keyFromHex(config.vaultKeyHex) : undefined;
  const store = new LocalStore();
  const spinner = ora(`Searching: "${query}"...`).start();

  try {
    const model = new LocalEmbeddingModel();
    const embedding = await model.embed(query);
    const results = store.search(embedding, opts.topK ?? 5, true);
    spinner.stop();

    if (!results.length) {
      console.log(t.warn('No results found in your indexed chunks.'));
      return;
    }

    console.log(t.heading(`\nTop ${results.length} results for: "${query}"\n`));
    results.forEach((r, i) => {
      const score = (r.score * 100).toFixed(1);
      // Private chunks are encrypted at rest — decrypt for display with the vault key.
      let content = r.content;
      if (r.isEncrypted) {
        if (vaultKey) {
          try { content = decrypt(r.content, vaultKey); }
          catch { content = t.dim('[encrypted — decryption failed]'); }
        } else {
          content = t.dim('[encrypted — no vault key configured]');
        }
      }
      const state = r.isPublic ? 'public' : r.isLocalOnly ? 'local' : 'private';
      console.log(t.bold(`[${i + 1}] ${r.title}`) + t.dim(` (${score}% match · yours · ${state})`));
      if (r.sourcePath) console.log(t.dim(`    ${r.sourcePath}`));
      console.log(t.body(content.slice(0, 200) + (content.length > 200 ? '...' : '')));
      console.log('');
    });
  } catch (e) {
    spinner.fail((e as Error).message);
  } finally {
    store.close();
  }
}

export async function vaultSetPublic(folders: string[]): Promise<void> {
  updateConfig({ publicFolders: folders });

  console.log(t.heading('\n  Public folders updated\n'));
  if (folders.length === 0) {
    console.log(t.dim('  No folders designated as public.'));
    console.log(t.dim('  Use rdk_index --public for individual chunks.'));
  } else {
    for (const folder of folders) {
      console.log(`  ${mark.ok()} ${t.body(folder)}`);
    }
    console.log('');
    console.log(t.dim('  Files in these folders will be marked public when indexed'));
    console.log(t.dim('  and synced automatically when rdk mcp:serve is running.'));
  }
  console.log('');
}

export async function vaultListPublic(): Promise<void> {
  const config = loadConfig();
  const folders = config.publicFolders ?? [];

  console.log(t.heading('\n  Public folders\n'));
  if (folders.length === 0) {
    console.log(t.dim('  None configured.'));
    console.log(t.dim('  Set with: rdk vault:set-public research/ published/'));
  } else {
    for (const folder of folders) {
      console.log(`  ${mark.ok()} ${t.body(folder)}`);
    }
  }
  console.log('');
}
