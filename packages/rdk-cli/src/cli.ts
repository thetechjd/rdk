// packages/rdk-cli/src/cli.ts
// RDK CLI — on-demand dependency loading.
//
// Install tiers:
//   Tier 1  pnpm install        → CLI shell only (~10MB, <15s)
//   Tier 2  rdk vault:connect   → vault adapter for your tool
//   Tier 3  rdk network:join    → @xenova/transformers + MCP SDK (~50MB)
//   Tier 4  rdk tips:enable     → ethers for on-chain settlement (~15MB)

import { Command } from 'commander';

const program = new Command();

program
  .name('rdk')
  .description('Retrieval Development Kit — distributed knowledge infrastructure')
  .version('1.0.0');

// ── Init ─────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Interactive setup wizard')
  .option('--email <email>')
  .option('--domain <domain>')
  .option('--vault <adapter>')
  .option('--path <path>')
  .action(async (opts) => {
    const { runInit } = await import('./commands/init.js');
    await runInit(opts.email ? opts : undefined);
  });

// ── Vault ─────────────────────────────────────────────────────────────────────

const vault = program.command('vault').description('Vault management');

vault
  .command('connect <adapter>')
  .description('Connect a vault: filesystem | obsidian | logseq | notion')
  .option('-p, --path <path>', 'Vault path')
  .action(async (adapter, opts) => {
    const { vaultConnect } = await import('./commands/vault.js');
    await vaultConnect(adapter, opts.path);
  });

vault
  .command('index')
  .description('Index vault (incremental by default)')
  .option('--force', 'Re-index all files')
  .option('--public-only')
  .action(async (opts) => {
    const { vaultIndex } = await import('./commands/vault.js');
    await vaultIndex({ force: opts.force, publicOnly: opts.publicOnly });
  });

vault
  .command('status')
  .description('Show vault index stats')
  .action(async () => {
    const { vaultStatus } = await import('./commands/vault.js');
    await vaultStatus();
  });

vault
  .command('search <query>')
  .description('Search private vault')
  .option('-k, --top-k <n>', 'Results', '5')
  .action(async (query, opts) => {
    const { vaultSearch } = await import('./commands/vault.js');
    await vaultSearch(query, { topK: parseInt(opts.topK, 10) });
  });

// Colon shorthands
program.command('vault:connect <adapter>').option('-p, --path <path>').action(async (a, o) => { const { vaultConnect } = await import('./commands/vault.js'); await vaultConnect(a, o.path); });
program.command('vault:index').option('--force').action(async (o) => { const { vaultIndex } = await import('./commands/vault.js'); await vaultIndex({ force: o.force }); });
program.command('vault:status').action(async () => { const { vaultStatus } = await import('./commands/vault.js'); await vaultStatus(); });
program.command('vault:search <query>').action(async (q) => { const { vaultSearch } = await import('./commands/vault.js'); await vaultSearch(q, {}); });

// ── Network ──────────────────────────────────────────────────────────────────

const network = program.command('network').description('Network commands');

network
  .command('join')
  .description('Join the RDK knowledge network (installs embedding model + MCP)')
  .action(async () => {
    const { networkJoin } = await import('./commands/network.js');
    await networkJoin();
  });

network
  .command('connect')
  .description('Authenticate with RDK Central')
  .action(async () => {
    const { networkConnect } = await import('./commands/network.js');
    await networkConnect();
  });

network
  .command('status')
  .description('Show network connection status')
  .action(async () => {
    const { networkStatus } = await import('./commands/network.js');
    await networkStatus();
  });

network
  .command('query <query>')
  .description('Test network query')
  .option('-d, --domain <domain>')
  .option('-k, --top-k <n>', 'Results', '5')
  .action(async (query, opts) => {
    const { networkQuery } = await import('./commands/network.js');
    await networkQuery(query, { domain: opts.domain, topK: parseInt(opts.topK, 10) });
  });

program.command('network:join').action(async () => { const { networkJoin } = await import('./commands/network.js'); await networkJoin(); });
program.command('network:connect').action(async () => { const { networkConnect } = await import('./commands/network.js'); await networkConnect(); });
program.command('network:status').action(async () => { const { networkStatus } = await import('./commands/network.js'); await networkStatus(); });
program.command('network:query <query>').action(async (q) => { const { networkQuery } = await import('./commands/network.js'); await networkQuery(q, {}); });

// ── MCP ───────────────────────────────────────────────────────────────────────

const mcp = program.command('mcp').description('MCP server commands');

mcp
  .command('serve')
  .description('Start MCP server for Claude Desktop')
  .option('-p, --port <port>', 'Port', '3000')
  .action(async (opts) => {
    const { mcpServe } = await import('./commands/mcp.js');
    await mcpServe({ port: parseInt(opts.port, 10) });
  });

mcp.command('validate').action(async () => { const { mcpValidate } = await import('./commands/mcp.js'); await mcpValidate(); });
mcp.command('test').action(async () => { const { mcpTest } = await import('./commands/mcp.js'); await mcpTest(); });

program.command('mcp:serve').option('-p, --port <port>', 'Port', '3000').action(async (o) => { const { mcpServe } = await import('./commands/mcp.js'); await mcpServe({ port: parseInt(o.port, 10) }); });
program.command('mcp:validate').action(async () => { const { mcpValidate } = await import('./commands/mcp.js'); await mcpValidate(); });

// ── Tips ──────────────────────────────────────────────────────────────────────

program
  .command('tips:enable')
  .description('Enable on-chain USDC tip earnings (installs ethers)')
  .action(async () => {
    const { tipsEnable } = await import('./commands/tips.js');
    await tipsEnable();
  });

program
  .command('tips:status')
  .description('Show tip queue and earnings')
  .action(async () => {
    const { tipsStatus } = await import('./commands/tips.js');
    await tipsStatus();
  });

// ── Publish ───────────────────────────────────────────────────────────────────

const publish = program.command('publish').description('Publish content to vault');

publish.command('chunk <text>').requiredOption('-t, --title <title>').option('--public').option('-d, --domain <d>').action(async (text, opts) => { const { publishChunk } = await import('./commands/publish.js'); await publishChunk(text, { title: opts.title, public: opts.public, domain: opts.domain }); });
publish.command('url <url>').option('--public').option('-d, --domain <d>').action(async (url, opts) => { const { publishUrl } = await import('./commands/publish.js'); await publishUrl(url, { public: opts.public, domain: opts.domain }); });
publish.command('file <path>').option('--public').option('-d, --domain <d>').action(async (p, opts) => { const { publishFile } = await import('./commands/publish.js'); await publishFile(p, { public: opts.public, domain: opts.domain }); });

program.command('publish:chunk <text>').requiredOption('-t, --title <t>').option('--public').action(async (t, o) => { const { publishChunk } = await import('./commands/publish.js'); await publishChunk(t, { title: o.title, public: o.public }); });
program.command('publish:url <url>').option('--public').action(async (url, o) => { const { publishUrl } = await import('./commands/publish.js'); await publishUrl(url, { public: o.public }); });
program.command('publish:file <path>').option('--public').action(async (p, o) => { const { publishFile } = await import('./commands/publish.js'); await publishFile(p, { public: o.public }); });

// ── Earnings ──────────────────────────────────────────────────────────────────

program.command('earnings').description('View tip earnings').action(async () => { const { showEarnings } = await import('./commands/account.js'); await showEarnings(); });
program.command('earnings:withdraw').description('Withdraw to wallet').action(async () => { const { withdrawEarnings } = await import('./commands/account.js'); await withdrawEarnings(); });

// ── Account ───────────────────────────────────────────────────────────────────

program.command('account').description('Show plan, node ID, stats').action(async () => { const { showAccount } = await import('./commands/account.js'); await showAccount(); });
program.command('account:login').description('Log in to RetroDecks account').action(async () => { const { accountLogin } = await import('./commands/account.js'); await accountLogin(); });
program.command('account:upgrade').description('Open billing portal').action(async () => { const { upgradeAccount } = await import('./commands/account.js'); await upgradeAccount(); });
program.command('account:apikey:rotate').description('Rotate API key').action(async () => { const { rotateApiKey } = await import('./commands/account.js'); await rotateApiKey(); });

// ── Dev / Testing ─────────────────────────────────────────────────────────────

program.command('dev').description('Dev mode with verbose logging').action(async () => {
  process.env.RDK_DEBUG = '1';
  const { mcpServe } = await import('./commands/mcp.js');
  await mcpServe({ port: 3000 });
});

program.command('test:connection').description('Test central API').action(async () => { const { networkConnect } = await import('./commands/network.js'); await networkConnect(); });

program.command('test:embedding <text>').description('Test embedding model').action(async (text: string) => {
  const { requireDeps } = await import('./require-dep.js');
  const ready = await requireDeps(['@xenova/transformers'], { label: 'Embedding model' });
  if (!ready) return;
  const ora = (await import('ora')).default;
  const spinner = ora('Running...').start();
  try {
    const { LocalEmbeddingModel } = await import('@rdk/core');
    const model = new LocalEmbeddingModel();
    const emb = await model.embed(text);
    spinner.succeed(`${model.dimensions}-dim vector. First 5: [${Array.from(emb.slice(0, 5)).map(v => v.toFixed(4)).join(', ')}]`);
  } catch (e) {
    spinner.fail((e as Error).message);
  }
});

// ── Splash ────────────────────────────────────────────────────────────────────

program.command('splash').description('Show RDK splash screen').action(async () => {
  const { splash } = await import('./theme.js');
  splash();
});

// ── Status overview ───────────────────────────────────────────────────────────

program.command('status').description('Show full node status').action(async () => {
  const { t, mark, divider } = await import('./theme.js');
  const { configExists, loadConfig } = await import('./config.js');

  if (!configExists()) {
    console.log(t.warn('\nNot initialized. Run: rdk init\n'));
    return;
  }

  const config = loadConfig();
  const { LocalStore } = await import('@rdk/core');
  const store = new LocalStore();
  const stats = store.getStats();
  const pendingTips = store.getPendingTipTotal();
  store.close();

  const hasXenova = await checkImport('@xenova/transformers');
  const hasMcp    = await checkImport('@modelcontextprotocol/sdk');
  const hasEthers = await checkImport('ethers');

  console.log(t.heading('\nRDK Node Status'));
  console.log(divider(42));
  console.log(`Node ID:   ${t.body(config.nodeId)}`);
  console.log(`Plan:      ${t.green(config.plan)}`);
  console.log(`Domain:    ${t.body(config.domain)}`);
  console.log('');
  console.log(`Vault:     ${t.body(`${config.vaultAdapter} @ ${config.vaultPath}`)}`);
  console.log(`Chunks:    ${t.body(`${stats.totalChunks.toLocaleString()} (${stats.privateChunks} private, ${stats.publicChunks} public)`)}`);
  console.log('');
  console.log(t.body('Components:'));
  console.log(`  Embedding model  ${hasXenova ? mark.ok() + ' ' + t.body('installed') : mark.error() + ' ' + t.muted('run: rdk network:join')}`);
  console.log(`  MCP server       ${hasMcp    ? mark.ok() + ' ' + t.body('installed') : mark.error() + ' ' + t.muted('run: rdk network:join')}`);
  console.log(`  Tip settlement   ${hasEthers ? mark.ok() + ' ' + t.body('installed') : mark.error() + ' ' + t.muted('run: rdk tips:enable')}`);
  if (pendingTips > 0) {
    console.log('');
    console.log(`Pending tips: ${t.green(`$${pendingTips.toFixed(4)} USDC`)}`);
  }
  console.log('');
});

async function checkImport(pkg: string): Promise<boolean> {
  try { await import(pkg); return true; } catch { return false; }
}

// ── Parse ─────────────────────────────────────────────────────────────────────

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
