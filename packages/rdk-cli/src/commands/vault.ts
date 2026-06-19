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

export async function vaultSync(opts: { force?: boolean } = {}): Promise<void> {
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
              summary: chunk.isPublic ? chunk.summary : undefined, // private summary stays on-node
              domain: chunk.domain ?? config.domain,
              categories: chunk.categories,
              embedding: Array.from(embedding),
              chunkTokens: Math.ceil(chunk.content.length / 4),
              isPublic: chunk.isPublic,
              isEncrypted: !chunk.isPublic,  // derived boolean (private ⟺ encrypted) — never a SQLite int
              freshnessAt: chunk.updatedAt.toISOString(),
            }],
          }),
          signal: AbortSignal.timeout(10000),
        });

        if (res.ok) {
          store.markSynced(chunk.id);
          synced++;
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

export async function vaultPublish(): Promise<void> {
  const { LocalStore } = await import('@rdk/core');
  const store = new LocalStore();
  const changed = store.markAllPublic();
  store.close();

  if (changed === 0) {
    console.log(t.dim('All chunks are already public.'));
  } else {
    console.log(t.body(`Marked ${changed} chunk${changed !== 1 ? 's' : ''} as public.`));
  }

  await vaultSync();
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
      console.log(t.bold(`[${i + 1}] ${r.title}`) + t.dim(` (${score}% match)`));
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
