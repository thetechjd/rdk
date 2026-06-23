// packages/rdk-cli/src/commands/network.ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, updateConfig } from '../config.js';
import { requireDeps } from '../require-dep.js';
import { input } from '../prompts.js';
import { t, mark, divider } from '../theme.js';

// Readable results from the last network query, persisted so `rdk save` can
// index them into the local store without re-querying (and re-paying).
interface SavableResult { title: string; content: string; domain?: string }
const LAST_QUERY_PATH = path.join(process.env.RDK_HOME ?? path.join(os.homedir(), '.rdk'), 'last-query.json');

/** Index readable network results into the local store as local-only chunks. */
async function saveResultsLocally(savable: SavableResult[]): Promise<void> {
  const ora = (await import('ora')).default;
  if (!savable.length) {
    console.log(t.warn('  Nothing to save from the last query.'));
    return;
  }
  const ready = await requireDeps(['@xenova/transformers'], { label: 'Embedding model' });
  if (!ready) return;

  const { LocalStore, LocalEmbeddingModel, RDKIndexer, keyFromHex } = await import('@rdk/core');
  const config = loadConfig();
  // No syncToNetwork — these are saved for local search only and never leave
  // the machine (localOnly also hard-excludes them from every sync path).
  const indexer = new RDKIndexer({
    embeddingModel: new LocalEmbeddingModel(),
    localStore: new LocalStore(),
    domain: config.domain,
    vaultKey: config.vaultKeyHex ? keyFromHex(config.vaultKeyHex) : undefined,
  });

  const spinner = ora(`Saving ${savable.length} result(s) to local knowledge...`).start();
  let saved = 0;
  for (const r of savable) {
    try {
      const res = await indexer.indexDocument({
        content: r.content,
        title: r.title,
        domain: r.domain ?? config.domain,
        isPublic: false,
        localOnly: true,
      });
      saved += res.chunksIndexed;
    } catch { /* skip individual failures */ }
  }
  spinner.succeed(`Saved ${saved} chunk(s) locally (this machine only).`);
  console.log(t.dim('  Future queries find these first — no network tip on re-retrieval.'));
}

/** `rdk save` — index the previous query's results into the local store. */
export async function saveLastQuery(): Promise<void> {
  let savable: SavableResult[] = [];
  try {
    savable = JSON.parse(fs.readFileSync(LAST_QUERY_PATH, 'utf-8')) as SavableResult[];
  } catch {
    console.log(t.warn('No recent query to save. Run rdk network:query "<query>" first,'));
    console.log(t.dim('  or save as you go with: rdk network:query "<query>" --save'));
    return;
  }
  await saveResultsLocally(savable);
}

function centralUrlOverride(): string | undefined {
  return process.env.RDK_CENTRAL_URL || process.env.RDK_API_URL;
}

async function registerCentralNode(config: ReturnType<typeof loadConfig>): Promise<{ nodeId: string; apiKey: string; centralApiUrl: string; plan: string }> {
  const centralApiUrl = await input({
    message: 'RDK Central URL:',
    default: centralUrlOverride() ?? config.centralApiUrl,
    validate: value => {
      try {
        new URL(value);
        return true;
      } catch {
        return 'Enter a valid URL, for example http://localhost:3000';
      }
    },
  });
  const email = await input({ message: 'Email for this RDK node:' });
  const displayName = await input({
    message: 'Node display name:',
    default: `RDK ${config.domain} node`,
  });

  const res = await fetch(`${centralApiUrl}/api/v1/nodes/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      displayName,
      contributionDomain: config.domain,
      walletAddress: config.walletAddress || undefined,
      walletChain: config.walletChain,
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const data = await res.json() as { nodeId: string; apiKey: string };
  return { ...data, centralApiUrl, plan: 'free' };
}

function isLocalNode(config: ReturnType<typeof loadConfig>): boolean {
  return config.nodeId.startsWith('local-') || config.apiKey.startsWith('rdk_local_');
}

export async function networkJoin(): Promise<void> {
  const ora = (await import('ora')).default;
  console.log(t.heading('\nJoining RDK network...\n'));

  const ready = await requireDeps(
    ['@xenova/transformers', '@modelcontextprotocol/sdk'],
    { label: 'Network + MCP components' },
  );
  if (!ready) return;

  const config = loadConfig();
  const spinner = ora('Connecting to RDK Central...').start();

  try {
    if (isLocalNode(config)) {
      spinner.stop();
      console.log(t.warn('This config is in offline mode and needs a real RDK Central node.'));
      const registered = await registerCentralNode(config);
      updateConfig({
        nodeId: registered.nodeId,
        apiKey: registered.apiKey,
        centralApiUrl: registered.centralApiUrl,
        plan: registered.plan,
      });
      spinner.succeed(`Registered — Node: ${registered.nodeId}, Plan: ${registered.plan}`);
    } else {
      const centralApiUrl = centralUrlOverride() ?? config.centralApiUrl;
      const res = await fetch(`${centralApiUrl}/api/v1/nodes/auth`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { nodeId: string; plan?: string };
      // Never let a missing plan in the auth response clobber the stored plan.
      const plan = data.plan ?? config.plan ?? 'free';
      updateConfig({ nodeId: data.nodeId, centralApiUrl, plan });
      spinner.succeed(`Connected — Node: ${data.nodeId}, Plan: ${plan}`);
    }
  } catch (e) {
    spinner.warn(`Could not reach central: ${(e as Error).message}`);
  }

  // Link the (possibly newly registered) node to the RetroDeck account so its
  // chunks surface in the dashboard. Idempotent; no-op if not logged in.
  const { ensureNodeLinked } = await import('../link-node.js');
  const link = await ensureNodeLinked();
  if (link.status === 'linked') {
    console.log(t.dim('  ✓ Node linked to your RetroDeck account'));
  } else if (link.status === 'skipped' && link.reason?.includes('logged in')) {
    console.log(t.dim('  Tip: run rdk account:login so your chunks appear in the dashboard'));
  } else if (link.status === 'failed') {
    console.log(t.warn(`  Could not link node to account (${link.reason}). Retry: rdk account:relink`));
  }

  console.log('');
  console.log(t.heading('  Add to Claude Desktop:'));
  console.log(`  ${t.green('rdk mcp:serve')}   start the MCP server`);
  console.log('');
  console.log(t.dim('  claude_desktop_config.json:'));
  console.log(t.dim('  { "mcpServers": { "rdk": {'));
  console.log(t.dim('      "command": "rdk", "args": ["mcp:serve"]'));
  console.log(t.dim('  } } }'));
  console.log('');
}

export async function networkConnect(): Promise<void> {
  const ora = (await import('ora')).default;
  const config = loadConfig();
  const centralApiUrl = centralUrlOverride() ?? config.centralApiUrl;
  const spinner = ora(`Connecting to ${centralApiUrl}...`).start();

  try {
    if (isLocalNode(config)) {
      spinner.fail('This config is in offline mode. Run: rdk network:join');
      return;
    }

    const res = await fetch(`${centralApiUrl}/api/v1/nodes/auth`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { nodeId: string; plan?: string; jwtToken: string };
    const plan = data.plan ?? config.plan ?? 'free';
    updateConfig({ nodeId: data.nodeId, centralApiUrl, plan });
    spinner.succeed(`Connected — Node ID: ${data.nodeId}, Plan: ${data.plan}`);
  } catch (e) {
    spinner.fail(`Authentication failed: ${(e as Error).message}`);
  }
}

export async function networkStatus(): Promise<void> {
  const ora = (await import('ora')).default;
  const config = loadConfig();
  const spinner = ora('Checking network...').start();

  try {
    const res = await fetch(`${config.centralApiUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const nodeRes = await fetch(`${config.centralApiUrl}/api/v1/nodes`, {
      signal: AbortSignal.timeout(5000),
    });
    spinner.stop();

    const nodeData = nodeRes.ok
      ? await nodeRes.json() as { total?: number }
      : null;

    console.log(t.heading('\nNetwork Status'));
    console.log(divider(40));
    console.log(`Central API:  ${res.ok ? mark.ok() + ' connected' : mark.error() + ' error'}`);
    console.log(`Peer nodes:   ${t.body(String(nodeData?.total ?? 'unknown'))}`);
    console.log(`Your node:    ${t.body(config.nodeId)}`);
    console.log(`Plan:         ${t.body(config.plan ?? 'free')}`);
    console.log(`Domain:       ${t.body(config.domain)}`);
  } catch (e) {
    spinner.fail(`Network unreachable: ${(e as Error).message}`);
  }
}

export async function networkQuery(query: string, opts: { domain?: string; topK?: number; save?: boolean }): Promise<void> {
  const ora = (await import('ora')).default;
  const ready = await requireDeps(['@xenova/transformers'], { label: 'Embedding model' });
  if (!ready) return;

  const config = loadConfig();
  const spinner = ora(`Querying network: "${query}"...`).start();

  try {
    const { LocalEmbeddingModel } = await import('@rdk/core');
    const model = new LocalEmbeddingModel();
    const embedding = await model.embed(query);

    // Exchange API key for JWT before querying
    const authRes = await fetch(`${config.centralApiUrl}/api/v1/nodes/auth`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!authRes.ok) throw new Error(`Auth failed: HTTP ${authRes.status}`);
    const { jwtToken } = await authRes.json() as { jwtToken: string };

    const res = await fetch(`${config.centralApiUrl}/api/v1/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        embedding: Array.from(embedding),
        topK: opts.topK ?? 5,
        domain: opts.domain ?? config.domain,
      }),
    });

    spinner.stop();
    if (!res.ok) {
      console.log(t.error(`Query failed: HTTP ${res.status}`));
      return;
    }

    const data = await res.json() as {
      results: Array<{
        title?: string;
        summary?: string;
        score?: number;
        tipAmountUsdc?: number;
        nodeId?: string;
        isEncrypted?: boolean;
        // Live-fetched content from the owning node: plaintext for public
        // chunks, ciphertext for private/team chunks. null if unavailable.
        contentEncrypted?: string | null;
      }>;
    };

    if (!data.results.length) {
      console.log(t.warn('No results.'));
      return;
    }

    const { decrypt, keyFromHex } = await import('@rdk/core');
    const sharedKeys = config.sharedVaultKeys ?? {};

    console.log(t.heading(`\nNetwork results for: "${query}"\n`));
    // Readable results (content resolved/decrypted) collected for save/--save.
    const savable: SavableResult[] = [];
    data.results.forEach((r, i) => {
      const score = ((r.score ?? 0) * 100).toFixed(1);
      const tip = r.tipAmountUsdc ? t.dim(`  ·  tip $${r.tipAmountUsdc.toFixed(4)} USDC`) : '';
      console.log(t.bold(`[${i + 1}] ${r.title ?? 'Untitled'}`) + t.dim(` (${score}% match)`) + tip);

      let content = r.contentEncrypted ?? '';
      // Team/private content arrives encrypted — decrypt with the shared vault
      // key for the owning node (or our own key). Public content is plaintext.
      if (content && r.isEncrypted) {
        const hex = (r.nodeId && sharedKeys[r.nodeId]) || config.vaultKeyHex;
        try { content = hex ? decrypt(content, keyFromHex(hex)) : ''; }
        catch { content = ''; }
        if (!content) {
          console.log(t.dim("    [encrypted — you don't have the vault key for this content]"));
          console.log('');
          return;
        }
      }

      if (content) {
        console.log(t.body(content.trim()));
        savable.push({ title: r.title ?? 'Untitled', content: content.trim(), domain: opts.domain ?? config.domain });
      } else if (r.summary) {
        console.log(t.dim(r.summary.trim()));
      } else {
        console.log(t.dim('    (content unavailable — the owning node may be offline or not serving)'));
      }
      console.log('');
    });

    // Persist readable results so `rdk save` can index them later without
    // re-querying (and re-paying the tip).
    try { fs.writeFileSync(LAST_QUERY_PATH, JSON.stringify(savable), { mode: 0o600 }); } catch { /* non-fatal */ }

    if (opts.save) {
      await saveResultsLocally(savable);
    } else if (savable.length) {
      console.log(t.dim('  Save these to your local knowledge: rdk save   (or query with --save)'));
      console.log('');
    }
  } catch (e) {
    spinner.fail((e as Error).message);
  }
}

export async function networkSync(): Promise<void> {
  const ora = (await import('ora')).default;
  const config = loadConfig();

  if (config.nodeId.startsWith('local-') || config.apiKey.startsWith('rdk_local_')) {
    console.log(t.warn('This node is in offline mode. Run: rdk network:join'));
    return;
  }

  const { LocalStore } = await import('@rdk/core');
  const store = new LocalStore();
  const stats = store.getStats();

  if (stats.pendingChunks === 0) {
    console.log(t.dim('  No unsynced chunks.'));
    store.close();
    return;
  }

  const spinner = ora(`  Syncing ${stats.pendingChunks} chunk(s)...`).start();

  try {
    const { SyncService } = await import('@retrodeck/mcp');
    const sync = new SyncService(
      {
        enabled: true,
        intervalMinutes: 0,
        centralApiUrl: config.centralApiUrl,
        centralApiKey: config.apiKey,
      },
      store,
    );

    const result = await sync.syncOnce();
    store.close();

    if (result.errors > 0) {
      spinner.warn(`  Synced ${result.synced}, ${result.errors} error(s)`);
    } else {
      spinner.succeed(`  ${result.synced} chunk(s) synced to network`);
    }
  } catch (e) {
    store.close();
    spinner.fail((e as Error).message);
  }
}
