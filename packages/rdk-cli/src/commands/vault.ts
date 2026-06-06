// packages/rdk-cli/src/commands/vault.ts
import { loadConfig } from '../config.js';
import { requireDeps } from '../require-dep.js';
import { t, divider } from '../theme.js';

export async function vaultConnect(adapter: string, vaultPath?: string): Promise<void> {
  const ora = (await import('ora')).default;
  const adapterKey = `@rdk/adapter-${adapter}`;
  console.log('');
  const ready = await requireDeps([adapterKey], { label: `Vault adapter for ${adapter}` });
  if (!ready) return;

  const config = loadConfig();
  const resolvedPath = vaultPath ?? config.vaultPath;

  const spinner = ora(`Connecting ${adapter} vault at ${resolvedPath}...`).start();
  try {
    const mod = await import(adapterKey);
    const adapterInst = new mod.default();
    await adapterInst.connect({ vaultPath: resolvedPath, domain: config.domain });
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
  const adapterKey = `@rdk/adapter-${config.vaultAdapter}`;

  const ready = await requireDeps(
    [adapterKey, '@xenova/transformers'],
    { label: 'Indexing components' },
  );
  if (!ready) return;

  const isPublic = opts.isPublic ?? true;
  const spinner = ora(`Indexing vault (${config.vaultAdapter})...`).start();
  try {
    const mod = await import(adapterKey);
    const adapter = new mod.default();
    await adapter.connect({ vaultPath: config.vaultPath, domain: config.domain });

    const result = opts.force
      ? await adapter.indexAll({ isPublic })
      : await adapter.indexChanged(
          new Date(Date.now() - 24 * 60 * 60 * 1000),
          { isPublic },
        );

    spinner.succeed(`${result.filesProcessed} files → ${result.chunksIndexed} chunks indexed (${isPublic ? 'public' : 'private'})`);

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
  console.log(`Adapter:      ${t.body(config.vaultAdapter)}`);
  console.log(`Path:         ${t.body(config.vaultPath)}`);
  console.log(`Domain:       ${t.body(config.domain)}`);
  console.log('');
  console.log(`Total chunks: ${t.body(stats.totalChunks.toLocaleString())}`);
  console.log(`  Private:    ${t.body(stats.privateChunks.toLocaleString())}`);
  console.log(`  Public:     ${t.body(stats.publicChunks.toLocaleString())}`);
  console.log(`  Unsynced:   ${t.body(stats.unsyncedChunks.toLocaleString())}`);
}

export async function vaultSync(): Promise<void> {
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

    spinner.text = 'Syncing public chunks to network...';

    const { LocalStore } = await import('@rdk/core');
    const store = new LocalStore();
    const chunks = store.getUnsyncedPublicChunks(100);

    if (!chunks.length) {
      store.close();
      spinner.succeed('Nothing to sync — all public chunks already on network');
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
              title: chunk.title,
              summary: chunk.summary,
              domain: chunk.domain ?? config.domain,
              categories: chunk.categories,
              embedding: Array.from(embedding),
              chunkTokens: Math.ceil(chunk.content.length / 4),
              isPublic: true,
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

  const { LocalStore, LocalEmbeddingModel } = await import('@rdk/core');
  const store = new LocalStore();
  const spinner = ora(`Searching: "${query}"...`).start();

  try {
    const model = new LocalEmbeddingModel();
    const embedding = await model.embed(query);
    const results = store.search(embedding, opts.topK ?? 5, true);
    spinner.stop();

    if (!results.length) {
      console.log(t.warn('No results in private vault.'));
      return;
    }

    console.log(t.heading(`\nTop ${results.length} results for: "${query}"\n`));
    results.forEach((r, i) => {
      const score = (r.score * 100).toFixed(1);
      console.log(t.bold(`[${i + 1}] ${r.title}`) + t.dim(` (${score}% match)`));
      if (r.sourcePath) console.log(t.dim(`    ${r.sourcePath}`));
      console.log(t.body(r.content.slice(0, 200) + (r.content.length > 200 ? '...' : '')));
      console.log('');
    });
  } catch (e) {
    spinner.fail((e as Error).message);
  } finally {
    store.close();
  }
}
