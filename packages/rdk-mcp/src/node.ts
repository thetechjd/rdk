// packages/rdk-mcp/src/node.ts
// Central stateful object for the MCP server session.
// Loads config from ~/.rdk/config.json, initializes store + router + indexer.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { LocalStore, RDKRouter, RDKIndexer, LocalEmbeddingModel, keyFromHex, type VaultKey } from '@rdk/core';
import { SyncService } from './sync-service.js';

export interface NodeConfig {
  nodeId: string;
  apiKey: string;
  centralApiUrl: string;
  plan: string;
  vaultAdapter: string;
  vaultPath: string;
  domain: string;
  walletAddress?: string;
  walletChain: string;
  mcpPort: number;
  autoSync?: boolean;
  syncIntervalMinutes?: number;
  publicFolders?: string[];
  vaultKeyHex?: string;
  sharedVaultKeys?: Record<string, string>;
}

interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export class RDKNode {
  private config!: NodeConfig;
  private store!: LocalStore;
  private router!: RDKRouter;
  private indexer!: RDKIndexer;
  private embeddingModel!: LocalEmbeddingModel;
  private syncService!: SyncService;
  private vaultLastIndexed?: Date;
  private vaultWatchUnsubscribe?: () => void;
  private jwtToken?: string;
  private jwtExpiry = 0;

  private async getJwt(): Promise<string> {
    if (this.jwtToken && Date.now() < this.jwtExpiry) return this.jwtToken;
    const res = await fetch(`${this.config.centralApiUrl}/api/v1/nodes/auth`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });
    if (!res.ok) throw new Error(`Auth failed: HTTP ${res.status}`);
    const { jwtToken } = await res.json() as { jwtToken: string };
    this.jwtToken = jwtToken;
    this.jwtExpiry = Date.now() + 55 * 60 * 1000;
    return jwtToken;
  }

  async init(): Promise<void> {
    this.config = this.loadConfig();
    this.store = new LocalStore();
    this.embeddingModel = new LocalEmbeddingModel();

    // Load encryption keys
    const vaultKey: VaultKey | undefined = this.config.vaultKeyHex
      ? keyFromHex(this.config.vaultKeyHex)
      : undefined;

    const sharedVaultKeys: Record<string, VaultKey> = {};
    for (const [nodeId, hexKey] of Object.entries(this.config.sharedVaultKeys ?? {})) {
      sharedVaultKeys[nodeId] = keyFromHex(hexKey);
    }

    this.router = new RDKRouter({
      localStore: this.store,
      embeddingModel: this.embeddingModel,
      centralApiUrl: this.config.centralApiUrl,
      centralApiKey: this.config.apiKey,
      domain: this.config.domain,
      topK: 5,
      minSimilarity: 0.50,
      fallbackToLLM: true,
      vaultKey,
      sharedVaultKeys,
    });

    this.indexer = new RDKIndexer({
      embeddingModel: this.embeddingModel,
      localStore: this.store,
      domain: this.config.domain,
      syncToNetwork: true,
      centralApiUrl: this.config.centralApiUrl,
      centralApiKey: this.config.apiKey,
      vaultKey,
    });

    this.syncService = new SyncService(
      {
        enabled: this.config.autoSync !== false,
        intervalMinutes: this.config.syncIntervalMinutes ?? 5,
        centralApiUrl: this.config.centralApiUrl,
        centralApiKey: this.config.apiKey,
      },
      this.store,
    );
    this.syncService.start();

    // Start vault file watcher — fires after MCP server is already accepting connections
    this.startVaultWatch().catch(e => console.error('[watch] init error:', (e as Error).message));
  }

  // ── Vault file watcher ───────────────────────────────────────────────────

  private resolveHome(p: string): string {
    if (p?.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    return p ?? '';
  }

  private async startVaultWatch(): Promise<void> {
    if (!this.config.vaultPath) return;

    const vaultPath = this.resolveHome(this.config.vaultPath);
    if (!fs.existsSync(vaultPath)) {
      console.error(`[watch] vault path not found: ${vaultPath}`);
      return;
    }

    // Start lookback 24h ago — catches files created/modified before this server restart
    let lastScan = Date.now() - 24 * 60 * 60 * 1000;

    const scan = async () => {
      const since = new Date(lastScan - 5_000); // 5s overlap catches edge cases
      lastScan = Date.now();
      const allFiles = this.listMarkdownFiles(vaultPath);
      console.error(`[watch] scanning ${allFiles.length} file(s) since ${since.toLocaleTimeString()}`);
      const changed: string[] = [];
      for (const fullPath of allFiles) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtime > since) changed.push(path.relative(vaultPath, fullPath));
        } catch { /* skip unreadable */ }
      }
      if (changed.length > 0) {
        console.error(`[watch] ${changed.length} file(s) changed: ${changed.map(f => path.basename(f)).join(', ')}`);
        await this.reindexFiles(vaultPath, changed);
      }
    };

    // Poll every 20 seconds — reliable on all filesystems (Obsidian atomic writes can miss fs.watch)
    const pollInterval = setInterval(() => {
      scan().catch(e => console.error('[watch] scan error:', (e as Error).message));
    }, 20_000);

    // Also wire up fs.watch for faster detection when it does fire
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let fsWatcher: ReturnType<typeof fs.watch> | null = null;
    try {
      fsWatcher = fs.watch(vaultPath, { recursive: true }, (_, filename) => {
        if (!filename?.match(/\.(md|txt|mdx)$/)) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          scan().catch(e => console.error('[watch] scan error:', (e as Error).message));
        }, 500);
      });
    } catch {
      // fs.watch unsupported on this filesystem — polling-only mode is fine
    }

    this.vaultWatchUnsubscribe = () => {
      clearInterval(pollInterval);
      fsWatcher?.close();
    };
    console.error(`[watch] watching vault at ${vaultPath}`);
  }

  private async reindexFiles(vaultPath: string, relPaths: string[]): Promise<void> {
    let chunksIndexed = 0;
    const errors: string[] = [];

    for (const relPath of relPaths) {
      const fullPath = path.join(vaultPath, relPath);
      try {
        if (!fs.existsSync(fullPath)) continue;
        const raw = fs.readFileSync(fullPath, 'utf-8');
        const { title: fmTitle, content } = this.parseFrontmatter(raw);
        const title = fmTitle || path.basename(fullPath, path.extname(fullPath));
        const isPublic = this.isPublicFile(relPath);

        const result = await this.indexer.indexDocument({
          content: content || raw,
          title,
          domain: this.config.domain,
          isPublic,
          sourceAdapter: this.config.vaultAdapter,
        });
        chunksIndexed += result.chunksIndexed;
        if (result.errors.length > 0) errors.push(...result.errors);
      } catch (e) {
        errors.push(`${path.basename(relPath)}: ${(e as Error).message}`);
      }
    }

    console.error(`[watch] indexed ${relPaths.length} file(s) → ${chunksIndexed} chunk(s)`);
    if (errors.length > 0) {
      console.error(`[watch] errors: ${errors.slice(0, 3).join('; ')}`);
    }
    if (chunksIndexed > 0) {
      this.syncService.syncOnce().catch(e => console.error('[watch] sync error:', (e as Error).message));
    }
  }

  // ── Tool Handlers ────────────────────────────────────────────────────────

  async handleQuery(
    query: string,
    opts: { domain?: string; includePrivate?: boolean; includeNetwork?: boolean; topK?: number },
  ): Promise<McpToolResult> {
    if (!query?.trim()) {
      return this.errorResult('query is required');
    }

    const result = await this.router.query(query, {
      domain: opts.domain ?? this.config.domain,
      topK: opts.topK ?? 5,
    });

    if (result.source === 'llm_fallback' || result.chunks.length === 0) {
      return this.textResult(
        `No relevant knowledge found in ${opts.includeNetwork !== false ? 'your indexed chunks or the public network' : 'your indexed chunks'}.\n` +
        `Source: llm_fallback — proceed with your training data or request more context.\n` +
        `Latency: ${result.latencyMs}ms`,
      );
    }

    const sourceLabel = result.source === 'private' ? 'Private Vault' : 'Knowledge Network';
    const tipsNote = result.tipsPaid.length > 0
      ? `\n\n💡 ${result.tipsPaid.length} tip(s) queued ($${result.tipsPaid.reduce((s, t) => s + t.amountUsdc, 0).toFixed(4)} USDC total)`
      : '';

    const contextText = result.context ||
      result.chunks.map((c, i) => {
        const chunk = c as { title?: string; content?: string; summary?: string; score?: number };
        return `[${i + 1}] ${chunk.title ?? 'Untitled'}\n${chunk.content ?? chunk.summary ?? ''}`;
      }).join('\n\n---\n\n');

    return this.textResult(
      `Source: ${sourceLabel} | Chunks: ${result.chunks.length} | Tokens: ~${result.tokenEstimate} | Latency: ${result.latencyMs}ms${tipsNote}\n\n` +
      `---\n\n${contextText}`,
    );
  }

  async handleIndex(opts: {
    content: string;
    title: string;
    isPublic?: boolean;
    domain?: string;
    categories?: string[];
  }): Promise<McpToolResult> {
    if (!opts.content || !opts.title) {
      return this.errorResult('content and title are required');
    }

    const result = await this.indexer.indexDocument({
      content: opts.content,
      title: opts.title,
      domain: opts.domain ?? this.config.domain,
      categories: opts.categories,
      isPublic: opts.isPublic ?? true,
      sourceAdapter: 'manual',
    });

    const syncNote = (opts.isPublic ?? true)
      ? ' Marked public — will sync to network.'
      : ' Stored privately (not shared with network).';

    if (result.errors.length > 0) {
      return this.textResult(
        `Indexed ${result.chunksIndexed} chunks with ${result.errors.length} error(s).\n` +
        `Errors: ${result.errors.join('; ')}${syncNote}`,
      );
    }

    return this.textResult(
      `Indexed "${opts.title}" → ${result.chunksIndexed} chunk(s).${syncNote}`,
    );
  }

  async handleIndexUrl(opts: {
    url: string;
    isPublic?: boolean;
    domain?: string;
  }): Promise<McpToolResult> {
    if (!opts.url) return this.errorResult('url is required');

    let content: string;
    let title: string;

    try {
      const response = await fetch(opts.url, {
        headers: { 'User-Agent': 'RDK-Node/1.0 (+https://rdk.network)' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return this.errorResult(`HTTP ${response.status} fetching ${opts.url}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      const raw = await response.text();

      if (contentType.includes('text/html')) {
        // Extract title from <title> tag
        const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(raw);
        title = titleMatch ? titleMatch[1].trim() : opts.url;
        // Strip HTML for content
        content = raw;
      } else {
        title = opts.url;
        content = raw;
      }
    } catch (e) {
      return this.errorResult(`Failed to fetch URL: ${(e as Error).message}`);
    }

    return this.handleIndex({
      content,
      title,
      isPublic: opts.isPublic ?? true,
      domain: opts.domain,
    });
  }

  async handleIndexVault(opts: { forceReindex?: boolean; publicOnly?: boolean }): Promise<McpToolResult> {
    if (!this.config.vaultPath) {
      return this.errorResult('No vault configured. Run rdk init to set up a vault.');
    }

    const vaultPath = this.resolveHome(this.config.vaultPath);
    if (!fs.existsSync(vaultPath)) {
      return this.errorResult(`Vault path not found: ${vaultPath}`);
    }

    try {
      const since = (!opts.forceReindex && this.vaultLastIndexed) ? this.vaultLastIndexed : undefined;
      const allFiles = this.listMarkdownFiles(vaultPath);

      let filesProcessed = 0;
      let chunksIndexed = 0;
      const errors: string[] = [];

      for (const fullPath of allFiles) {
        try {
          const relPath = path.relative(vaultPath, fullPath);
          const isPublic = this.isPublicFile(relPath);
          if (opts.publicOnly && !isPublic) continue;

          if (since) {
            const stat = fs.statSync(fullPath);
            if (stat.mtime <= since) continue;
          }

          const raw = fs.readFileSync(fullPath, 'utf-8');
          const { title: fmTitle, content } = this.parseFrontmatter(raw);
          const title = fmTitle || path.basename(fullPath, path.extname(fullPath));

          const result = await this.indexer.indexDocument({
            content: content || raw,
            title,
            domain: this.config.domain,
            isPublic,
            sourceAdapter: this.config.vaultAdapter,
          });
          filesProcessed++;
          chunksIndexed += result.chunksIndexed;
          if (result.errors.length > 0) errors.push(...result.errors);
        } catch (e) {
          errors.push(`${path.basename(fullPath)}: ${(e as Error).message}`);
        }
      }

      this.vaultLastIndexed = new Date();

      const errNote = errors.length > 0 ? `\n${errors.length} error(s): ${errors.slice(0, 3).join('; ')}` : '';
      return this.textResult(
        `Vault indexed: ${filesProcessed} files → ${chunksIndexed} chunks.${errNote}`,
      );
    } catch (e) {
      return this.errorResult(`Vault index failed: ${(e as Error).message}`);
    }
  }

  async handleStatus(): Promise<McpToolResult> {
    const stats = this.store.getStats();
    const pendingTips = this.store.getPendingTipTotal();
    const configPath = path.join(os.homedir(), '.rdk', 'config.json');
    const configExists = fs.existsSync(configPath);

    const networkStatus = await this.checkNetworkConnectivity();

    const sync = this.syncService.getStatus();

    return this.textResult([
      `RDK Node Status`,
      `───────────────────────────────`,
      `Node ID:        ${this.config.nodeId}`,
      `Plan:           ${this.config.plan}`,
      `Domain:         ${this.config.domain}`,
      ``,
      `Vault:          ${this.config.vaultAdapter} @ ${this.config.vaultPath}`,
      `Last indexed:   ${this.vaultLastIndexed?.toLocaleString() ?? 'never'}`,
      ``,
      `Chunks (local): ${stats.totalChunks.toLocaleString()} total`,
      `  Private:      ${stats.privateChunks.toLocaleString()}`,
      `  Public:       ${stats.publicChunks.toLocaleString()}`,
      `  Unsynced:     ${stats.unsyncedChunks.toLocaleString()}`,
      ``,
      `Auto-sync:      ${sync.enabled ? 'enabled' : 'disabled'}`,
      `Sync interval:  ${sync.intervalMinutes} minutes`,
      `Sync loop:      ${sync.running ? 'running' : 'stopped'}`,
      ``,
      `Tips pending:   $${pendingTips.toFixed(4)} USDC`,
      `Network:        ${networkStatus}`,
      `Config:         ${configExists ? configPath : 'not found — run rdk init'}`,
    ].join('\n'));
  }

  async handleEarnings(): Promise<McpToolResult> {
    if (!this.config.centralApiUrl || !this.config.apiKey) {
      return this.errorResult('Not connected to network. Run rdk network:connect');
    }

    try {
      const jwt = await this.getJwt();
      const response = await fetch(`${this.config.centralApiUrl}/api/v1/tips/earnings`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });

      if (!response.ok) {
        return this.errorResult(`Failed to fetch earnings: HTTP ${response.status}`);
      }

      const data = await response.json() as {
        totalUsdc: number;
        pendingUsdc: number;
        settledUsdc: number;
        tipHistory: Array<{ id: string; amount_usdc: number; status: string; created_at: string }>;
      };

      const recent = data.tipHistory.slice(0, 5).map(t =>
        `  ${new Date(t.created_at).toLocaleDateString()}  $${Number(t.amount_usdc).toFixed(4)}  ${t.status}`,
      ).join('\n');

      return this.textResult([
        `RDK Tip Earnings`,
        `───────────────────────────────`,
        `Total earned:   $${data.totalUsdc.toFixed(4)} USDC`,
        `Settled:        $${data.settledUsdc.toFixed(4)} USDC`,
        `Pending:        $${data.pendingUsdc.toFixed(4)} USDC`,
        ``,
        `Recent tips:`,
        recent || '  (none yet)',
        ``,
        `Wallet:         ${this.config.walletAddress ?? 'not configured'}`,
        `Chain:          ${this.config.walletChain}`,
      ].join('\n'));
    } catch (e) {
      return this.errorResult(`Earnings fetch failed: ${(e as Error).message}`);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private loadConfig(): NodeConfig {
    const rdkHome = process.env.RDK_HOME ?? path.join(os.homedir(), '.rdk');
    const configPath = path.join(rdkHome, 'config.json');
    if (!fs.existsSync(configPath)) {
      return {
        nodeId: 'uninitialized',
        apiKey: '',
        centralApiUrl: 'https://rdk.retrodeck.ai',
        plan: 'free',
        vaultAdapter: 'filesystem',
        vaultPath: path.join(os.homedir(), 'Documents'),
        domain: 'general',
        walletChain: 'base',
        mcpPort: 4242,
      };
    }
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as NodeConfig;
    raw.apiKey = this.decryptValue(raw.apiKey);
    if (raw.vaultKeyHex) raw.vaultKeyHex = this.decryptValue(raw.vaultKeyHex);
    if (raw.sharedVaultKeys) {
      for (const [nodeId, key] of Object.entries(raw.sharedVaultKeys)) {
        raw.sharedVaultKeys[nodeId] = this.decryptValue(key);
      }
    }
    return raw;
  }

  private decryptValue(stored: string): string {
    if (!stored?.startsWith('enc:')) return stored;
    const machineKey = crypto.createHash('sha256')
      .update(`${os.hostname()}${os.userInfo().username}`)
      .digest();
    const buf = Buffer.from(stored.slice(4), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', machineKey, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return decipher.update(buf.subarray(28)).toString('utf-8') + decipher.final('utf-8');
  }

  private parseFrontmatter(raw: string): { title: string; content: string } {
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)/.exec(raw);
    if (!match) return { title: '', content: raw };
    const fm = match[1];
    const content = match[2];
    const titleMatch = /^title:\s*(.+)$/m.exec(fm);
    const title = titleMatch ? titleMatch[1].trim().replace(/^['"]|['"]$/g, '') : '';
    return { title, content };
  }

  private listMarkdownFiles(dir: string): string[] {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...this.listMarkdownFiles(fullPath));
        } else if (/\.(md|txt|mdx)$/.test(entry.name)) {
          results.push(fullPath);
        }
      }
    } catch {
      // skip unreadable dirs
    }
    return results;
  }

  private isPublicFile(relPath: string): boolean {
    const publicFolders = this.config.publicFolders ?? [];
    if (publicFolders.length === 0) return false;
    return publicFolders.some(f => relPath.startsWith(f + '/') || relPath.startsWith(f + path.sep));
  }

  private async checkNetworkConnectivity(): Promise<string> {
    if (!this.config.centralApiUrl) return 'not configured';
    try {
      const res = await fetch(`${this.config.centralApiUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok ? 'connected' : `error (HTTP ${res.status})`;
    } catch {
      return 'unreachable';
    }
  }

  private textResult(text: string): McpToolResult {
    return { content: [{ type: 'text', text }] };
  }

  private errorResult(message: string): McpToolResult {
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }
}
