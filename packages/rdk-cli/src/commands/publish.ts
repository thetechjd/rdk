// packages/rdk-cli/src/commands/publish.ts
import fs from 'fs';
import { loadConfig } from '../config.js';
import { requireDeps } from '../require-dep.js';
import { t } from '../theme.js';

async function getIndexer() {
  const ready = await requireDeps(['@xenova/transformers'], { label: 'Embedding model' });
  if (!ready) return null;

  const { LocalStore, LocalEmbeddingModel, RDKIndexer, keyFromHex } = await import('@rdk/core');
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
    vaultKey: config.vaultKeyHex ? keyFromHex(config.vaultKeyHex) : undefined,
    onChunkIndexed: pushChunkIndexed,
  });
}

export async function indexChunk(text: string, opts: { title: string; domain?: string; local?: boolean }): Promise<void> {
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
      localOnly: opts.local,
    });
    if (opts.local) {
      spinner.succeed(`"${opts.title}" → ${result.chunksIndexed} chunk(s) saved locally`);
      console.log(t.dim('  Stored on this machine only — not synced to the network.'));
    } else {
      spinner.succeed(`"${opts.title}" → ${result.chunksIndexed} chunk(s) indexed privately`);
      console.log(t.dim('  Encrypted with your vault key. Visible only to you and your team.'));
    }
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

// ── URL / file ingestion ────────────────────────────────────────────────────
// Shared core. Visibility is decided by the caller, NOT a flag default:
//   publish:url / publish:file  → always PUBLIC  ("publish" means public)
//   index:url   / index:file    → always PRIVATE ("index" means private)

function outcome(isPublic: boolean, localOnly?: boolean): string {
  if (localOnly) return 'saved locally';
  return isPublic ? 'published publicly' : 'indexed privately';
}

async function ingestUrl(url: string, isPublic: boolean, domain?: string, localOnly?: boolean): Promise<void> {
  const ora = (await import('ora')).default;
  const indexer = await getIndexer();
  if (!indexer) return;

  const config = loadConfig();
  const verb = localOnly ? 'Saving' : isPublic ? 'Publishing' : 'Indexing';
  const spinner = ora(`Fetching ${url}...`).start();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(raw);
    const title = titleMatch ? titleMatch[1].trim() : url;
    spinner.text = `${verb} "${title}"...`;

    const result = await indexer.indexDocument({
      content: raw,
      title,
      domain: domain ?? config.domain,
      isPublic,
      localOnly,
      sourcePath: url,
    });
    spinner.succeed(`"${title}" → ${result.chunksIndexed} chunk(s) ${outcome(isPublic, localOnly)}`);
    if (localOnly) console.log(t.dim('  Stored on this machine only — not synced to the network.'));
    result.errors.forEach((e: string) => console.log(t.warn(`  ${e}`)));
  } catch (e) {
    spinner.fail((e as Error).message);
  }
}

async function ingestFile(filePath: string, isPublic: boolean, domain?: string, localOnly?: boolean): Promise<void> {
  const ora = (await import('ora')).default;
  if (!fs.existsSync(filePath)) {
    console.error(t.error(`File not found: ${filePath}`));
    process.exit(1);
  }

  const indexer = await getIndexer();
  if (!indexer) return;

  const config = loadConfig();
  const verb = localOnly ? 'Saving' : isPublic ? 'Publishing' : 'Indexing';
  const spinner = ora(`${verb} ${filePath}...`).start();
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const title = filePath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? filePath;
    const result = await indexer.indexDocument({
      content,
      title,
      domain: domain ?? config.domain,
      isPublic,
      localOnly,
      sourcePath: filePath,
    });
    spinner.succeed(`"${title}" → ${result.chunksIndexed} chunk(s) ${outcome(isPublic, localOnly)}`);
    if (localOnly) console.log(t.dim('  Stored on this machine only — not synced to the network.'));
    result.errors.forEach((e: string) => console.log(t.warn(`  ${e}`)));
  } catch (e) {
    spinner.fail((e as Error).message);
  }
}

// publish:* — always PUBLIC. A passed --public flag is now redundant (warned).
export async function publishUrl(url: string, opts: { public?: boolean; domain?: string }): Promise<void> {
  if (opts.public) console.log(t.warn('  Note: --public is no longer needed; publish:url is always public.'));
  await ingestUrl(url, true, opts.domain);
}

export async function publishFile(filePath: string, opts: { public?: boolean; domain?: string }): Promise<void> {
  if (opts.public) console.log(t.warn('  Note: --public is no longer needed; publish:file is always public.'));
  await ingestFile(filePath, true, opts.domain);
}

// index:* — PRIVATE (encrypted on the network), or local-only with --local.
export async function indexUrl(url: string, opts: { domain?: string; local?: boolean } = {}): Promise<void> {
  await ingestUrl(url, false, opts.domain, opts.local);
}

export async function indexFile(filePath: string, opts: { domain?: string; local?: boolean } = {}): Promise<void> {
  await ingestFile(filePath, false, opts.domain, opts.local);
}
