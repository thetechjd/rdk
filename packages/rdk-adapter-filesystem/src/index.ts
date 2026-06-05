// packages/rdk-adapter-filesystem/src/index.ts
// Reads .md, .txt, .mdx files from a directory tree.
// Respects .rdkignore file (gitignore syntax).
// Subdirectory structure → becomes category hierarchy.

import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import matter from 'gray-matter';
import type {
  VaultAdapter,
  AdapterConfig,
  IndexOptions,
  IndexResult,
  RetrievedChunk,
  FileChange,
  VaultMetadata,
} from '@rdk/core';
import { LocalStore, RDKIndexer } from '@rdk/core';

export interface FilesystemAdapterConfig extends AdapterConfig {
  rootPath: string;
  extensions?: string[];
  domain?: string;
}

export class FilesystemAdapter implements VaultAdapter {
  name = 'filesystem';
  description = 'Indexes .md, .txt, and .mdx files from a local directory.';

  private config!: FilesystemAdapterConfig;
  private store!: LocalStore;
  private indexer!: RDKIndexer;
  private lastIndexed?: Date;
  private watchers: (() => void)[] = [];

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config as FilesystemAdapterConfig;
    const rootPath = this.resolveHome(this.config.rootPath as string);

    if (!fs.existsSync(rootPath)) {
      throw new Error(`Vault path does not exist: ${rootPath}`);
    }

    this.store = new LocalStore();

    // Import embedding model lazily
    const { LocalEmbeddingModel } = await import('@rdk/core');
    const embeddingModel = new LocalEmbeddingModel();

    this.indexer = new RDKIndexer({
      embeddingModel,
      localStore: this.store,
      domain: (this.config.domain as string) ?? 'general',
      syncToNetwork: false, // sync is triggered separately
    });
  }

  async indexAll(options: IndexOptions = {}): Promise<IndexResult> {
    const rootPath = this.resolveHome(this.config.rootPath as string);
    const extensions = (this.config.extensions as string[]) ?? ['.md', '.txt', '.mdx'];
    const files = await this.getFiles(rootPath, extensions);

    let chunksIndexed = 0;
    let chunksSkipped = 0;
    let filesProcessed = 0;
    const errors: string[] = [];
    const categories: string[][] = [];

    for (const filePath of files) {
      try {
        const doc = this.readFile(filePath, rootPath, options);
        const result = await this.indexer.indexDocument(doc);
        chunksIndexed += result.chunksIndexed;
        categories.push(...result.categories);
        filesProcessed++;
      } catch (e) {
        errors.push(`${filePath}: ${(e as Error).message}`);
      }
    }

    this.lastIndexed = new Date();
    return { chunksIndexed, chunksSkipped, filesProcessed, errors, categories };
  }

  async indexChanged(since: Date, options: IndexOptions = {}): Promise<IndexResult> {
    const rootPath = this.resolveHome(this.config.rootPath as string);
    const extensions = (this.config.extensions as string[]) ?? ['.md', '.txt', '.mdx'];
    const files = await this.getFiles(rootPath, extensions);

    // Filter to files modified since last index
    const changed = files.filter(f => {
      try {
        const stat = fs.statSync(f);
        return stat.mtime > since;
      } catch {
        return false;
      }
    });

    let chunksIndexed = 0;
    let chunksSkipped = 0;
    let filesProcessed = 0;
    const errors: string[] = [];
    const categories: string[][] = [];

    for (const filePath of changed) {
      try {
        const doc = this.readFile(filePath, rootPath, options);
        const result = await this.indexer.indexDocument(doc);
        chunksIndexed += result.chunksIndexed;
        categories.push(...result.categories);
        filesProcessed++;
      } catch (e) {
        errors.push(`${filePath}: ${(e as Error).message}`);
      }
    }

    this.lastIndexed = new Date();
    return { chunksIndexed, chunksSkipped, filesProcessed, errors, categories };
  }

  search(embedding: Float32Array, topK: number): Promise<RetrievedChunk[]> {
    const results = this.store.search(embedding, topK, true);
    return Promise.resolve(
      results.map(r => ({
        id: r.id,
        title: r.title,
        content: r.content,
        summary: r.summary,
        domain: r.domain,
        categories: r.categories,
        score: r.score,
        sourcePath: r.sourcePath,
        sourceAdapter: 'filesystem',
      })),
    );
  }

  watch(callback: (changes: FileChange[]) => void): () => void {
    // Use chokidar for filesystem watching
    let chokidar: typeof import('chokidar');
    let watcher: import('chokidar').FSWatcher;

    const rootPath = this.resolveHome(this.config.rootPath as string);

    import('chokidar').then((mod) => {
      chokidar = mod;
      watcher = chokidar.watch(rootPath, {
        ignored: /(^|[/\\])\../, // hidden files
        persistent: true,
        ignoreInitial: true,
      });

      const pendingChanges: FileChange[] = [];
      let debounceTimer: ReturnType<typeof setTimeout>;

      const flush = () => {
        if (pendingChanges.length > 0) {
          callback([...pendingChanges]);
          pendingChanges.length = 0;
        }
      };

      const scheduleFlush = () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(flush, 500);
      };

      watcher
        .on('add', p => { pendingChanges.push({ path: p, type: 'added' }); scheduleFlush(); })
        .on('change', p => { pendingChanges.push({ path: p, type: 'modified' }); scheduleFlush(); })
        .on('unlink', p => { pendingChanges.push({ path: p, type: 'deleted' }); scheduleFlush(); });
    });

    const unsubscribe = () => { watcher?.close(); };
    this.watchers.push(unsubscribe);
    return unsubscribe;
  }

  getMetadata(): VaultMetadata {
    const stats = this.store.getStats();
    return {
      adapterName: 'filesystem',
      vaultPath: this.resolveHome(this.config.rootPath as string),
      documentCount: stats.totalChunks,
      lastIndexed: this.lastIndexed,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private readFile(filePath: string, rootPath: string, options: IndexOptions) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const ext = path.extname(filePath).toLowerCase();
    let content = raw;
    let title = path.basename(filePath, ext);
    let frontmatterCategories: string[] | undefined;

    // Parse frontmatter for .md/.mdx
    if (ext === '.md' || ext === '.mdx') {
      try {
        const parsed = matter(raw);
        content = parsed.content;
        if (parsed.data.title) title = parsed.data.title as string;
        if (parsed.data.tags) {
          frontmatterCategories = Array.isArray(parsed.data.tags)
            ? (parsed.data.tags as string[])
            : [String(parsed.data.tags)];
        }
      } catch {}
    }

    // Directory path → category hints
    const relPath = path.relative(rootPath, filePath);
    const dirParts = path.dirname(relPath).split(path.sep).filter(p => p !== '.');

    return {
      content,
      title,
      sourcePath: filePath,
      sourceAdapter: 'filesystem',
      domain: (this.config.domain as string) ?? options.domain ?? 'general',
      categories: frontmatterCategories ?? dirParts,
      isPublic: options.isPublic ?? false,
    };
  }

  private async getFiles(rootPath: string, extensions: string[]): Promise<string[]> {
    const patterns = extensions.map(ext => `**/*${ext}`);
    const ignore = this.getIgnorePatterns(rootPath);

    const files: string[] = [];
    for (const pattern of patterns) {
      const found = await glob(pattern, {
        cwd: rootPath,
        absolute: true,
        ignore,
        nodir: true,
      });
      files.push(...found);
    }

    return [...new Set(files)]; // deduplicate
  }

  private getIgnorePatterns(rootPath: string): string[] {
    const ignorePath = path.join(rootPath, '.rdkignore');
    const defaults = ['**/node_modules/**', '**/.git/**', '**/.obsidian/**'];

    if (fs.existsSync(ignorePath)) {
      const lines = fs.readFileSync(ignorePath, 'utf-8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
      return [...defaults, ...lines];
    }
    return defaults;
  }

  private resolveHome(p: string): string {
    if (p.startsWith('~/')) {
      const os = require('os');
      return path.join(os.homedir(), p.slice(2));
    }
    return path.resolve(p);
  }
}
