// packages/rdk-cli/src/commands/publish.ts
import fs from 'fs';
import { loadConfig } from '../config.js';
import { requireDeps } from '../require-dep.js';
import { t } from '../theme.js';

async function getIndexer() {
  const ready = await requireDeps(['@xenova/transformers'], { label: 'Embedding model' });
  if (!ready) return null;

  const { LocalStore, LocalEmbeddingModel, RDKIndexer } = await import('@rdk/core');
  const { pushChunkIndexed } = await import('../ws/events.js');
  const config = loadConfig();
  const model = new LocalEmbeddingModel();
  const store = new LocalStore();
  return new RDKIndexer({
    embeddingModel: model,
    localStore: store,
    domain: config.domain,
    syncToNetwork: true,
    centralApiUrl: config.centralApiUrl,
    centralApiKey: config.apiKey,
    onChunkIndexed: pushChunkIndexed,
  });
}

export async function indexChunk(text: string, opts: { title: string; domain?: string }): Promise<void> {
  const ora = (await import('ora')).default;
  const indexer = await getIndexer();
  if (!indexer) return;

  const config = loadConfig();
  const spinner = ora('Indexing chunk...').start();
  try {
    const result = await indexer.indexDocument({
      content: text,
      title: opts.title,
      domain: opts.domain ?? config.domain,
      isPublic: false,
    });
    spinner.succeed(`"${opts.title}" → ${result.chunksIndexed} chunk(s) indexed privately`);
    console.log(t.dim('  Encrypted with your vault key. Visible only to you and your team.'));
    result.errors.forEach((e: string) => console.log(t.warn(`  ${e}`)));
  } catch (e) {
    spinner.fail((e as Error).message);
  }
}

export async function publishChunk(text: string, opts: { title: string; public?: boolean; domain?: string }): Promise<void> {
  const ora = (await import('ora')).default;

  if (opts.public) {
    console.log(t.warn('  Note: the --public flag is no longer needed; publish:chunk is always public.'));
  }

  const indexer = await getIndexer();
  if (!indexer) return;

  const config = loadConfig();
  const spinner = ora('Publishing chunk...').start();
  try {
    const result = await indexer.indexDocument({
      content: text,
      title: opts.title,
      domain: opts.domain ?? config.domain,
      isPublic: true,
    });
    spinner.succeed(`"${opts.title}" → ${result.chunksIndexed} chunk(s) published publicly`);
    console.log(t.dim('  Now retrievable by any node on the network. Earns tips when used.'));
    console.log(t.warn('  Note: public chunks are immutable and cannot be made private again.'));
    result.errors.forEach((e: string) => console.log(t.warn(`  ${e}`)));
  } catch (e) {
    spinner.fail((e as Error).message);
  }
}

export async function publishUrl(url: string, opts: { public?: boolean; domain?: string }): Promise<void> {
  const ora = (await import('ora')).default;
  const indexer = await getIndexer();
  if (!indexer) return;

  const config = loadConfig();
  const spinner = ora(`Fetching ${url}...`).start();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(raw);
    const title = titleMatch ? titleMatch[1].trim() : url;
    spinner.text = `Indexing "${title}"...`;

    const result = await indexer.indexDocument({
      content: raw,
      title,
      domain: opts.domain ?? config.domain,
      isPublic: opts.public ?? false,
      sourcePath: url,
    });
    spinner.succeed(`"${title}" → ${result.chunksIndexed} chunk(s)${opts.public ? ' published publicly' : ' indexed privately'}`);
  } catch (e) {
    spinner.fail((e as Error).message);
  }
}

export async function publishFile(filePath: string, opts: { public?: boolean; domain?: string }): Promise<void> {
  const ora = (await import('ora')).default;
  if (!fs.existsSync(filePath)) {
    console.error(t.error(`File not found: ${filePath}`));
    process.exit(1);
  }

  const indexer = await getIndexer();
  if (!indexer) return;

  const config = loadConfig();
  const spinner = ora(`Indexing ${filePath}...`).start();
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const title = filePath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? filePath;
    const result = await indexer.indexDocument({
      content,
      title,
      domain: opts.domain ?? config.domain,
      isPublic: opts.public ?? false,
      sourcePath: filePath,
    });
    spinner.succeed(`"${title}" → ${result.chunksIndexed} chunk(s)${opts.public ? ' published publicly' : ' indexed privately'}`);
  } catch (e) {
    spinner.fail((e as Error).message);
  }
}
