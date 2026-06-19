// packages/rdk-cli/src/cli.ts
// RDK CLI — on-demand dependency loading.
//
// Install tiers:
//   Tier 1  pnpm install        → CLI shell only (~10MB, <15s)
//   Tier 2  rdk vault:connect   → vault adapter for your tool
//   Tier 3  rdk network:join    → @xenova/transformers + MCP SDK (~50MB)
//   Tier 4  rdk tips:enable     → ethers for on-chain settlement (~15MB)


import { Command } from 'commander';
import { relinkOnDemandDeps } from './require-dep.js';
import { t } from './theme.js';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json') as { version: string };

// Re-link on-demand deps (~/.rdk) into this install. After a brew/curl upgrade
// the install path changes, so previously-installed deps need re-linking here.
relinkOnDemandDeps();

const program = new Command();

program
  .name('rdk')
  .description('Retrieval Development Kit — distributed knowledge infrastructure')
  .version(version);

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
  .description('Connect a local vault (Obsidian, filesystem, etc.) for indexing')
  .option('-p, --path <path>', 'Vault path')
  .action(async (adapter, opts) => {
    const { vaultConnect } = await import('./commands/vault.js');
    await vaultConnect(adapter, opts.path);
  });

vault
  .command('index')
  .description('Index files from your local vault. Private by default; public if in a folder marked via vault:set-public')
  .option('--force', 'Re-index all files')
  .option('--public', 'Index as public (shared on network, earns tips)')
  .action(async (opts) => {
    const { vaultIndex } = await import('./commands/vault.js');
    await vaultIndex({ force: opts.force, isPublic: !!opts.public });
  });

vault
  .command('sync')
  .description('Sync unsynced chunks (private + public) to the network')
  .option('--force', 'Re-sync all chunks, ignoring synced status')
  .action(async (opts) => {
    const { vaultSync } = await import('./commands/vault.js');
    await vaultSync({ force: !!opts.force });
  });

vault
  .command('publish')
  .description('Mark all private chunks as public and sync to network')
  .action(async () => {
    const { vaultPublish } = await import('./commands/vault.js');
    await vaultPublish();
  });

vault
  .command('status')
  .description('Show local vault stats and indexed chunk counts')
  .action(async () => {
    const { vaultStatus } = await import('./commands/vault.js');
    await vaultStatus();
  });

vault
  .command('search <query>')
  .description('Search your indexed chunks (private + public) from this node')
  .option('-k, --top-k <n>', 'Results', '5')
  .action(async (query, opts) => {
    const { vaultSearch } = await import('./commands/vault.js');
    await vaultSearch(query, { topK: parseInt(opts.topK, 10) });
  });

vault
  .command('set-public [folders...]')
  .description('Designate vault folders as public (auto-synced to network)')
  .action(async (folders: string[]) => {
    const { vaultSetPublic } = await import('./commands/vault.js');
    await vaultSetPublic(folders ?? []);
  });

vault
  .command('list-public')
  .description('Show which vault folders are designated as public')
  .action(async () => {
    const { vaultListPublic } = await import('./commands/vault.js');
    await vaultListPublic();
  });

// Colon shorthands
program.command('vault:connect <adapter>').option('-p, --path <path>').action(async (a, o) => { const { vaultConnect } = await import('./commands/vault.js'); await vaultConnect(a, o.path); });
program.command('vault:index').option('--force').option('--public').action(async (o) => { const { vaultIndex } = await import('./commands/vault.js'); await vaultIndex({ force: o.force, isPublic: !!o.public }); });
program.command('vault:sync').option('--force', 'Re-sync all chunks, ignoring synced status').action(async (opts) => { const { vaultSync } = await import('./commands/vault.js'); await vaultSync({ force: !!opts.force }); });
program.command('vault:publish').action(async () => { const { vaultPublish } = await import('./commands/vault.js'); await vaultPublish(); });
program.command('vault:status').action(async () => { const { vaultStatus } = await import('./commands/vault.js'); await vaultStatus(); });
program.command('vault:search <query>').action(async (q) => { const { vaultSearch } = await import('./commands/vault.js'); await vaultSearch(q, {}); });
program.command('vault:set-public [folders...]').action(async (f: string[]) => { const { vaultSetPublic } = await import('./commands/vault.js'); await vaultSetPublic(f ?? []); });
program.command('vault:list-public').action(async () => { const { vaultListPublic } = await import('./commands/vault.js'); await vaultListPublic(); });

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
  .description('Search the public network and your indexed chunks for relevant knowledge')
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
program.command('network:sync').description('[deprecated] use vault:sync').option('--force').action(async (opts) => { console.error(t.dim('  note: `rdk network:sync` is deprecated — use `rdk vault:sync`')); const { vaultSync } = await import('./commands/vault.js'); await vaultSync({ force: !!opts.force }); });

// Top-level shorthand
program.command('sync').description('[deprecated] use vault:sync').option('--force').action(async (opts) => { console.error(t.dim('  note: `rdk sync` is deprecated — use `rdk vault:sync`')); const { vaultSync } = await import('./commands/vault.js'); await vaultSync({ force: !!opts.force }); });

// ── MCP ───────────────────────────────────────────────────────────────────────

const mcp = program.command('mcp').description('MCP server commands');

mcp
  .command('serve')
  .description('Start MCP server for Claude Desktop')
  .option('-p, --port <port>', 'Port')
  .action(async (opts) => {
    const { mcpServe } = await import('./commands/mcp.js');
    await mcpServe({ port: opts.port ? parseInt(opts.port, 10) : undefined });
  });

mcp.command('validate').action(async () => { const { mcpValidate } = await import('./commands/mcp.js'); await mcpValidate(); });
mcp.command('test').action(async () => { const { mcpTest } = await import('./commands/mcp.js'); await mcpTest(); });

program.command('mcp:serve').option('-p, --port <port>', 'Port').action(async (o) => { const { mcpServe } = await import('./commands/mcp.js'); await mcpServe({ port: o.port ? parseInt(o.port, 10) : undefined }); });
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

// ── Index (private) ───────────────────────────────────────────────────────────

// Bare `rdk index` indexes your whole vault privately (alias for vault:index).
// Subcommands index a single chunk/url/file privately.
const indexCmd = program.command('index')
  .description('Index your vault privately (or a single chunk/url/file)')
  .option('--force', 'Re-index all vault files')
  .option('--public', 'Index as public (folders set via vault:set-public)')
  .action(async (opts) => {
    const { vaultIndex } = await import('./commands/vault.js');
    await vaultIndex({ force: opts.force, isPublic: !!opts.public });
  });

indexCmd.command('chunk <text>').requiredOption('-t, --title <title>').option('-d, --domain <d>').description('Index text content as a private encrypted chunk on the network').action(async (text, opts) => { const { indexChunk } = await import('./commands/publish.js'); await indexChunk(text, { title: opts.title, domain: opts.domain }); });
indexCmd.command('url <url>').option('-d, --domain <d>').description('Index a URL privately (encrypted on the network)').action(async (url, opts) => { const { indexUrl } = await import('./commands/publish.js'); await indexUrl(url, { domain: opts.domain }); });
indexCmd.command('file <path>').option('-d, --domain <d>').description('Index a file privately (encrypted on the network)').action(async (p, opts) => { const { indexFile } = await import('./commands/publish.js'); await indexFile(p, { domain: opts.domain }); });

program.command('index:chunk <text>').requiredOption('-t, --title <t>').option('-d, --domain <d>').description('Index text content as a private encrypted chunk on the network').action(async (t, o) => { const { indexChunk } = await import('./commands/publish.js'); await indexChunk(t, { title: o.title, domain: o.domain }); });
program.command('index:url <url>').option('-d, --domain <d>').description('Index a URL privately (encrypted on the network)').action(async (url, o) => { const { indexUrl } = await import('./commands/publish.js'); await indexUrl(url, { domain: o.domain }); });
program.command('index:file <path>').option('-d, --domain <d>').description('Index a file privately (encrypted on the network)').action(async (p, o) => { const { indexFile } = await import('./commands/publish.js'); await indexFile(p, { domain: o.domain }); });

// ── Publish (public) ──────────────────────────────────────────────────────────

const publish = program.command('publish').description('Publish content publicly on the network');

publish.command('chunk <text>').requiredOption('-t, --title <title>').option('--public').option('-d, --domain <d>').description('Publish text content publicly on the network. Earns tips when retrieved. Immutable.').action(async (text, opts) => { const { publishChunk } = await import('./commands/publish.js'); await publishChunk(text, { title: opts.title, public: opts.public, domain: opts.domain }); });
publish.command('url <url>').option('--public').option('-d, --domain <d>').action(async (url, opts) => { const { publishUrl } = await import('./commands/publish.js'); await publishUrl(url, { public: opts.public, domain: opts.domain }); });
publish.command('file <path>').option('--public').option('-d, --domain <d>').action(async (p, opts) => { const { publishFile } = await import('./commands/publish.js'); await publishFile(p, { public: opts.public, domain: opts.domain }); });

program.command('publish:chunk <text>').requiredOption('-t, --title <t>').option('--public').description('Publish text content publicly on the network. Earns tips when retrieved. Immutable.').action(async (t, o) => { const { publishChunk } = await import('./commands/publish.js'); await publishChunk(t, { title: o.title, public: o.public }); });
program.command('publish:url <url>').option('--public').action(async (url, o) => { const { publishUrl } = await import('./commands/publish.js'); await publishUrl(url, { public: o.public }); });
program.command('publish:file <path>').option('--public').action(async (p, o) => { const { publishFile } = await import('./commands/publish.js'); await publishFile(p, { public: o.public }); });

// ── Earnings ──────────────────────────────────────────────────────────────────

program.command('earnings').description('View tip earnings').action(async () => { const { showEarnings } = await import('./commands/account.js'); await showEarnings(); });
program.command('earnings:withdraw').description('Withdraw to wallet').action(async () => { const { withdrawEarnings } = await import('./commands/account.js'); await withdrawEarnings(); });

// ── Account ───────────────────────────────────────────────────────────────────

program.command('account').description('Show plan, node ID, stats').action(async () => { const { showAccount } = await import('./commands/account.js'); await showAccount(); });
program.command('account:login').description('Log in to RetroDeck account').action(async () => { const { accountLogin } = await import('./commands/account.js'); await accountLogin(); });
program.command('account:upgrade').description('Open billing portal').action(async () => { const { upgradeAccount } = await import('./commands/account.js'); await upgradeAccount(); });
program.command('account:relink').description('Link this node to your RetroDeck account (fixes empty dashboard)').action(async () => { const { accountRelink } = await import('./commands/account.js'); await accountRelink(); });
program.command('balance').description('Show your current USDC balance').action(async () => { const { showBalance } = await import('./commands/balance.js'); await showBalance(); });
program.command('account:apikey:rotate').description('Rotate API key').action(async () => { const { rotateApiKey } = await import('./commands/account.js'); await rotateApiKey(); });

// ── Team ──────────────────────────────────────────────────────────────────────

program.command('team:invite <email>').description('Grant a team member access to decrypt your private chunks').action(async (email: string) => { const { teamInvite } = await import('./commands/team.js'); await teamInvite(email); });
program.command('team:accept <inviteId>').description('Accept a team vault access invite').action(async (id: string) => { const { teamAccept } = await import('./commands/team.js'); await teamAccept(id); });
program.command('team:list').description('List team members with access to your private chunks').action(async () => { const { teamList } = await import('./commands/team.js'); await teamList(); });
program.command('team:revoke <email>').description('Revoke a team member\'s access to your private chunks').action(async (email: string) => { const { teamRevoke } = await import('./commands/team.js'); await teamRevoke(email); });
program.command('vault:rotate-key').description('Generate a new encryption key for your private chunks. Invalidates all existing team access.').action(async () => { const { rotateVaultKey } = await import('./commands/team.js'); await rotateVaultKey(); });

// ── Service ───────────────────────────────────────────────────────────────────

program.command('service:install')
  .description('Register RDK to auto-start on boot')
  .action(async () => {
    const { serviceInstall } = await import('./commands/service/index.js');
    await serviceInstall();
  });

program.command('service:start')
  .description('Start RDK service')
  .action(async () => {
    const { serviceStart } = await import('./commands/service/index.js');
    await serviceStart();
  });

program.command('service:stop')
  .description('Stop RDK service')
  .action(async () => {
    const { serviceStop } = await import('./commands/service/index.js');
    await serviceStop();
  });

program.command('service:status')
  .description('Show RDK service status')
  .action(async () => {
    const { serviceStatus } = await import('./commands/service/index.js');
    await serviceStatus();
  });

program.command('service:uninstall')
  .description('Remove RDK auto-start')
  .action(async () => {
    const { serviceUninstall } = await import('./commands/service/index.js');
    await serviceUninstall();
  });

// ── Dev / Testing ─────────────────────────────────────────────────────────────

program.command('dev').description('Dev mode with verbose logging').action(async () => {
  process.env.RDK_DEBUG = '1';
  const { mcpServe } = await import('./commands/mcp.js');
  await mcpServe({ port: undefined });
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

  // Check if mcp:serve is running by probing the HTTP server
  let mcpRunning = false;
  try {
    const res = await fetch(`http://localhost:${config.mcpPort ?? 4242}/.well-known/mcp.json`, {
      signal: AbortSignal.timeout(500),
    });
    mcpRunning = res.ok;
  } catch {}

  console.log(t.heading('\nRDK Node Status'));
  console.log(divider(42));
  console.log(`${t.dim('node id:')}   ${t.body(config.nodeId)}`);
  console.log(`${t.dim('plan:')}      ${t.green(config.plan)}`);
  console.log(`${t.dim('domain:')}    ${t.body(config.domain)}`);
  console.log('');
  console.log(t.heading('Content'));
  console.log(`  ${t.dim('local vault:')}    ${t.body(`${config.vaultAdapter} @ ${config.vaultPath}`)}`);
  console.log(`  ${t.dim('indexed chunks:')} ${t.body(stats.totalChunks.toLocaleString())}`);
  console.log(`    ${t.dim('private:')}      ${t.body(stats.privateChunks.toLocaleString())}  ${t.dim('(encrypted on network)')}`);
  console.log(`    ${t.dim('public:')}       ${t.body(stats.publicChunks.toLocaleString())}  ${t.dim('(plaintext, earning)')}`);
  console.log('');
  console.log(t.body('Components:'));
  console.log(`  Embedding model  ${hasXenova ? mark.ok() + ' ' + t.body('installed') : mark.error() + ' ' + t.muted('run: rdk network:join')}`);
  console.log(`  MCP server       ${hasMcp    ? mark.ok() + ' ' + t.body('installed') : mark.error() + ' ' + t.muted('run: rdk network:join')}`);
  console.log(`  Tip settlement   ${hasEthers ? mark.ok() + ' ' + t.body('installed') : mark.error() + ' ' + t.muted('run: rdk tips:enable')}`);
  console.log(`  ${t.dim('live sync:')}      ${mcpRunning ? t.green('● connected') : t.dim('○ offline')}${!mcpRunning ? t.dim('  (start with rdk mcp:serve)') : ''}`);
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
