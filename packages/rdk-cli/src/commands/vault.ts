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

export async function vaultIndex(opts: { force?: boolean; publicOnly?: boolean }): Promise<void> {
  const ora = (await import('ora')).default;
  const config = loadConfig();
  const adapterKey = `@rdk/adapter-${config.vaultAdapter}`;

  const ready = await requireDeps(
    [adapterKey, '@xenova/transformers'],
    { label: 'Indexing components' },
  );
  if (!ready) return;

  const spinner = ora(`Indexing vault (${config.vaultAdapter})...`).start();
  try {
    const mod = await import(adapterKey);
    const adapter = new mod.default();
    await adapter.connect({ vaultPath: config.vaultPath, domain: config.domain });

    const result = opts.force
      ? await adapter.indexAll({ isPublic: opts.publicOnly ?? false })
      : await adapter.indexChanged(
          new Date(Date.now() - 24 * 60 * 60 * 1000),
          { isPublic: opts.publicOnly ?? false },
        );

    spinner.succeed(`${result.filesProcessed} files → ${result.chunksIndexed} chunks indexed`);

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
