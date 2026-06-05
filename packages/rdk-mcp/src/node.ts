// packages/rdk-mcp/src/node.ts
// Central stateful object for the MCP server session.
// Loads config from ~/.rdk/config.json, initializes store + router + indexer.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { LocalStore, RDKRouter, RDKIndexer, LocalEmbeddingModel } from '@rdk/core';

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
  private vaultLastIndexed?: Date;

  async init(): Promise<void> {
    this.config = this.loadConfig();
    this.store = new LocalStore();
    this.embeddingModel = new LocalEmbeddingModel();

    this.router = new RDKRouter({
      localStore: this.store,
      embeddingModel: this.embeddingModel,
      centralApiUrl: this.config.centralApiUrl,
      centralApiKey: this.config.apiKey,
      domain: this.config.domain,
      topK: 5,
      minSimilarity: 0.72,
      fallbackToLLM: true,
    });

    this.indexer = new RDKIndexer({
      embeddingModel: this.embeddingModel,
      localStore: this.store,
      domain: this.config.domain,
      syncToNetwork: true,
      centralApiUrl: this.config.centralApiUrl,
      centralApiKey: this.config.apiKey,
    });
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
        `No relevant knowledge found in ${opts.includeNetwork !== false ? 'private vault or network' : 'private vault'}.\n` +
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
      isPublic: opts.isPublic ?? false,
      sourceAdapter: 'manual',
    });

    const syncNote = (opts.isPublic ?? false)
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
      isPublic: opts.isPublic,
      domain: opts.domain,
    });
  }

  async handleIndexVault(opts: { forceReindex?: boolean; publicOnly?: boolean }): Promise<McpToolResult> {
    if (!this.config.vaultPath) {
      return this.errorResult('No vault configured. Run rdk init to set up a vault.');
    }

    try {
      const adapterModule = await this.loadVaultAdapter();
      if (!adapterModule) {
        return this.errorResult(`Vault adapter "${this.config.vaultAdapter}" not found. Install @rdk/adapter-${this.config.vaultAdapter}`);
      }

      const adapter = new adapterModule.default();
      await adapter.connect({
        rootPath: this.config.vaultPath,
        domain: this.config.domain,
      });

      let result;
      if (opts.forceReindex || !this.vaultLastIndexed) {
        result = await adapter.indexAll({ isPublic: opts.publicOnly ?? false });
      } else {
        result = await adapter.indexChanged(this.vaultLastIndexed, { isPublic: opts.publicOnly ?? false });
      }

      this.vaultLastIndexed = new Date();

      const errNote = result.errors.length > 0 ? `\n${result.errors.length} error(s): ${result.errors.slice(0, 3).join('; ')}` : '';
      return this.textResult(
        `Vault indexed: ${result.filesProcessed} files → ${result.chunksIndexed} chunks.${errNote}`,
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
      const response = await fetch(`${this.config.centralApiUrl}/api/v1/tips/earnings`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
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
    const configPath = path.join(os.homedir(), '.rdk', 'config.json');
    if (!fs.existsSync(configPath)) {
      // Return a minimal offline config so the server starts
      return {
        nodeId: 'uninitialized',
        apiKey: '',
        centralApiUrl: 'https://api.rdk.network',
        plan: 'free',
        vaultAdapter: 'filesystem',
        vaultPath: path.join(os.homedir(), 'Documents'),
        domain: 'general',
        walletChain: 'base',
        mcpPort: 3000,
      };
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as NodeConfig;
  }

  private async loadVaultAdapter() {
    const adapterMap: Record<string, string> = {
      filesystem: '@rdk/adapter-filesystem',
      obsidian:   '@rdk/adapter-obsidian',
      logseq:     '@rdk/adapter-logseq',
      notion:     '@rdk/adapter-notion',
    };

    const pkgName = adapterMap[this.config.vaultAdapter];
    if (!pkgName) return null;

    try {
      return await import(pkgName);
    } catch {
      return null;
    }
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
