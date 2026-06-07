// packages/rdk-adapter-obsidian/src/index.ts
// Obsidian vault adapter.
// - Reads .md files from vault directory
// - Parses YAML frontmatter for metadata (tags, date, status, aliases)
// - Resolves [[wikilinks]] — inlines linked note content for richer context
// - Handles #tags from frontmatter and inline
// - Respects .rdkignore or .obsidianignore
// - Tracks link graph: notes with many incoming links get quality boost

import fs from 'fs';
import path from 'path';
import os from 'os';
import { glob } from 'glob';
import matter from 'gray-matter';
import type {
  VaultAdapter, AdapterConfig, IndexOptions, IndexResult,
  RetrievedChunk, FileChange, VaultMetadata,
} from '@rdk/core';
import { LocalStore, RDKIndexer, LocalEmbeddingModel } from '@rdk/core';

export interface ObsidianAdapterConfig extends AdapterConfig {
  vaultPath: string;
  domain?: string;
  resolveWikilinks?: boolean;   // default true
  includeJournals?: boolean;    // default false
  maxWikilinkDepth?: number;    // default 1 (don't recurse wikilinks of wikilinks)
}

interface PageLink {
  from: string;
  to: string;
}

export default class ObsidianAdapter implements VaultAdapter {
  name = 'obsidian';
  description = 'Indexes Obsidian vault with wikilink resolution and frontmatter parsing.';

  private config!: ObsidianAdapterConfig;
  private store!: LocalStore;
  private indexer!: RDKIndexer;
  private lastIndexed?: Date;
  private linkGraph: Map<string, Set<string>> = new Map(); // target → Set<sources>

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config as ObsidianAdapterConfig;
    const vaultPath = this.resolveHome(this.config.vaultPath as string);

    if (!fs.existsSync(vaultPath)) {
      throw new Error(`Obsidian vault not found: ${vaultPath}`);
    }

    this.store = new LocalStore();
    const model = new LocalEmbeddingModel();
    this.indexer = new RDKIndexer({
      embeddingModel: model,
      localStore: this.store,
      domain: (this.config.domain as string) ?? 'general',
    });
  }

  async indexAll(options: IndexOptions = {}): Promise<IndexResult> {
    const vaultPath = this.resolveHome(this.config.vaultPath as string);
    const files = await this.getMarkdownFiles(vaultPath);

    // Build link graph first so quality scores can use backlink count
    this.buildLinkGraph(files, vaultPath);

    let chunksIndexed = 0;
    let chunksSkipped = 0;
    let filesProcessed = 0;
    const errors: string[] = [];
    const categories: string[][] = [];

    for (const filePath of files) {
      try {
        const doc = this.readObsidianFile(filePath, vaultPath, options);
        if (!doc) continue; // filtered (journal, template, etc.)

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
    const vaultPath = this.resolveHome(this.config.vaultPath as string);
    const files = await this.getMarkdownFiles(vaultPath);
    const changed = files.filter(f => {
      try { return fs.statSync(f).mtime > since; } catch { return false; }
    });

    let chunksIndexed = 0, chunksSkipped = 0, filesProcessed = 0;
    const errors: string[] = [], categories: string[][] = [];

    for (const filePath of changed) {
      try {
        const doc = this.readObsidianFile(filePath, vaultPath, options);
        if (!doc) continue;
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
        sourceAdapter: 'obsidian',
      })),
    );
  }

  watch(callback: (changes: FileChange[]) => void): () => void {
    const vaultPath = this.resolveHome(this.config.vaultPath as string);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let watcher: any;

    // @ts-ignore — chokidar is optional; resolved at runtime
    import('chokidar').then(chokidar => {
      watcher = chokidar.watch(`${vaultPath}/**/*.md`, {
        ignored: /\.obsidian/,
        persistent: true,
        ignoreInitial: true,
      });

      const pending: FileChange[] = [];
      let timer: ReturnType<typeof setTimeout>;
      const flush = () => { if (pending.length) { callback([...pending]); pending.length = 0; } };

      watcher
        .on('add', (p: string) => { pending.push({ path: p, type: 'added' }); clearTimeout(timer); timer = setTimeout(flush, 500); })
        .on('change', (p: string) => { pending.push({ path: p, type: 'modified' }); clearTimeout(timer); timer = setTimeout(flush, 500); })
        .on('unlink', (p: string) => { pending.push({ path: p, type: 'deleted' }); clearTimeout(timer); timer = setTimeout(flush, 500); });
    });

    return () => { watcher?.close(); };
  }

  getMetadata(): VaultMetadata {
    const stats = this.store.getStats();
    return {
      adapterName: 'obsidian',
      vaultPath: this.resolveHome(this.config.vaultPath as string),
      documentCount: stats.totalChunks,
      lastIndexed: this.lastIndexed,
    };
  }

  // ── Obsidian-specific parsing ─────────────────────────────────────────────

  private readObsidianFile(
    filePath: string,
    vaultPath: string,
    options: IndexOptions,
  ) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = matter(raw);
    let content = parsed.content;
    const data = parsed.data as Record<string, unknown>;

    // Filter journals unless explicitly included
    const isJournal = filePath.includes('/journal') || filePath.includes('/daily');
    if (isJournal && !(this.config.includeJournals as boolean)) return null;

    // Filter templates
    if (filePath.includes('/template') || String(data.template ?? '') === 'true') return null;

    // Build title from frontmatter or filename
    const aliases = Array.isArray(data.aliases) ? data.aliases : [];
    const title = String(data.title ?? aliases[0] ?? path.basename(filePath, '.md'));

    // Resolve [[wikilinks]] — replace with inline content (depth 1)
    const resolveWikilinks = this.config.resolveWikilinks !== false;
    if (resolveWikilinks) {
      content = this.resolveWikilinksInContent(content, vaultPath, filePath);
    }

    // Extract tags from frontmatter + inline #tags
    const frontmatterTags = this.extractTags(data);
    const inlineTags = this.extractInlineTags(content);
    const categories = [...new Set([...frontmatterTags, ...inlineTags])];

    // Quality hint: backlink count (notes referenced by many others are likely important)
    const relPath = path.relative(vaultPath, filePath);
    const backlinks = this.linkGraph.get(relPath)?.size ?? 0;
    const qualityHint = Math.min(backlinks * 5, 25); // up to +25 quality from backlinks
    const isExplicitlyPublic = data.rdk_public === true;

    return {
      content,
      title,
      sourcePath: filePath,
      sourceAdapter: 'obsidian',
      domain: (this.config.domain as string) ?? options.domain ?? 'general',
      categories: categories.length > 0 ? categories : undefined,
      isPublic: isExplicitlyPublic || this.isInPublicFolder(relPath) || (options.isPublic ?? false),
    };
  }

  private isInPublicFolder(relPath: string): boolean {
    const publicFolders = (this.config.publicFolders as string[]) ?? [];
    if (publicFolders.length === 0) return false;
    return publicFolders.some(folder => {
      const normalized = folder.endsWith('/') ? folder : `${folder}/`;
      return relPath.startsWith(normalized);
    });
  }

  private resolveWikilinksInContent(content: string, vaultPath: string, sourceFile: string): string {
    // Match [[Note Title]] and [[Note Title|Alias]]
    return content.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, (match, noteName) => {
      try {
        const linkedContent = this.findAndReadNote(noteName.trim(), vaultPath, sourceFile);
        if (linkedContent) {
          // Include a short excerpt from the linked note (first 200 chars)
          const excerpt = linkedContent.slice(0, 200).replace(/\n+/g, ' ').trim();
          return `${noteName} (${excerpt}...)`;
        }
      } catch {}
      return noteName; // fallback to just the note name
    });
  }

  private findAndReadNote(noteName: string, vaultPath: string, _sourceFile: string): string | null {
    // Try exact path match first
    const exactPath = path.join(vaultPath, `${noteName}.md`);
    if (fs.existsSync(exactPath)) {
      const raw = fs.readFileSync(exactPath, 'utf-8');
      return matter(raw).content;
    }

    // Try recursive search (Obsidian allows links without path)
    const candidates = this.findFilesByName(vaultPath, `${noteName}.md`);
    if (candidates.length > 0) {
      const raw = fs.readFileSync(candidates[0], 'utf-8');
      return matter(raw).content;
    }

    return null;
  }

  private findFilesByName(dir: string, filename: string): string[] {
    const results: string[] = [];
    const search = (d: string) => {
      try {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            search(full);
          } else if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
            results.push(full);
          }
        }
      } catch {}
    };
    search(dir);
    return results;
  }

  private buildLinkGraph(files: string[], vaultPath: string): void {
    this.linkGraph.clear();
    for (const filePath of files) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const content = matter(raw).content;
        const links = [...content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)];

        for (const match of links) { const target = match[1];
          const targetPath = `${target.trim()}.md`;
          const existing = this.linkGraph.get(targetPath) ?? new Set<string>();
          existing.add(filePath);
          this.linkGraph.set(targetPath, existing);
        }
      } catch {}
    }
  }

  private extractTags(frontmatter: Record<string, unknown>): string[] {
    const tags: string[] = [];
    const raw = frontmatter.tags;
    if (Array.isArray(raw)) {
      tags.push(...raw.map(t => String(t).replace(/^#/, '').toLowerCase()));
    } else if (typeof raw === 'string') {
      tags.push(...raw.split(/[\s,]+/).map(t => t.replace(/^#/, '').toLowerCase()).filter(Boolean));
    }
    return tags;
  }

  private extractInlineTags(content: string): string[] {
    const matches = content.match(/#([a-zA-Z][a-zA-Z0-9_-]*)/g) ?? [];
    return matches.map(t => t.slice(1).toLowerCase());
  }

  private async getMarkdownFiles(vaultPath: string): Promise<string[]> {
    const ignore = this.buildIgnoreList(vaultPath);
    return glob('**/*.md', { cwd: vaultPath, absolute: true, ignore, nodir: true });
  }

  private buildIgnoreList(vaultPath: string): string[] {
    const defaults = ['**/.obsidian/**', '**/node_modules/**', '**/.git/**'];

    const ignoreFiles = [
      path.join(vaultPath, '.rdkignore'),
      path.join(vaultPath, '.obsidianignore'),
    ];

    for (const ignoreFile of ignoreFiles) {
      if (fs.existsSync(ignoreFile)) {
        const lines = fs.readFileSync(ignoreFile, 'utf-8')
          .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        return [...defaults, ...lines];
      }
    }
    return defaults;
  }

  private resolveHome(p: string): string {
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    return path.resolve(p);
  }
}
