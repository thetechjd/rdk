// One process and one encrypted vault: the host's shared node (every tenant,
// separated per document in RetroDeck), or one scope's node in per-scope mode.
// No tenant-supplied code runs here.
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { configExists, loadConfig, saveConfig } from '../packages/rdk-node/dist/config.js';
import { registerNode } from '../packages/rdk-node/dist/register-node.js';
import { NodeController, CentralClient, SubzeroSupportSync } from '../packages/rdk-node/dist/index.js';
let node;
let busy = false;
async function registerSharedNode(host) {
  const res = await fetch(`${process.env.RDK_CENTRAL_URL.replace(/\/$/, '')}/api/v1/internal/support-hosts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Support-Host-Secret': process.env.RDK_SUPPORT_HOST_SECRET },
    body: JSON.stringify({ host, displayName: `${process.env.COCOA_NODE_LABEL ?? 'Cocoa'} shared support node` }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Shared node registration failed: HTTP ${res.status}`);
  const r = await res.json();
  if (typeof r.nodeId !== 'string' || typeof r.apiKey !== 'string') throw new Error('Shared node registration returned no identity');
  return { nodeId: r.nodeId, apiKey: r.apiKey };
}
process.on('message', async ({ id, action, body }) => {
  if (busy) { process.send?.({ id, error: 'busy' }); return; }
  busy = true;
  try {
    if (!node) {
      if (!configExists()) {
        const vaultPath = join(process.env.RDK_HOME, 'vault');
        await mkdir(vaultPath, { recursive: true, mode: 0o700 });
        const host = process.env.RDK_SUPPORT_HOST_NAME;
        // Shared node: registered as the host, by service credential, with no email.
        const registered = host ? await registerSharedNode(host) : await registerNode({ centralApiUrl: process.env.RDK_CENTRAL_URL, email: body.email, displayName: `${process.env.COCOA_NODE_LABEL ?? 'Cocoa'} ${process.env.COCOA_NODE_SCOPE}`, domain: 'support' });
        saveConfig({ ...registered, centralApiUrl: process.env.RDK_CENTRAL_URL, ownerEmail: host ? `${host}@support-host.invalid` : body.email, plan: 'free', vaultAdapter: 'filesystem', vaultPath, domain: 'support', walletChain: 'base', mcpPort: 0, createdAt: new Date().toISOString(), vaultKeyHex: randomBytes(32).toString('hex'), defaultVisibility: 'private', autoSync: true });
      }
      node = new NodeController({ logger: () => {} });
      await node.start();
    }
    const config = loadConfig();
    if (action === 'ensure') process.send?.({ id, result: { nodeId: config.nodeId, nodeApiKey: config.apiKey } });
    else if (action === 'sync') {
      const worker = new SubzeroSupportSync(body.apiUrl, body.token, body.projectId, node,
        new CentralClient({ centralApiUrl: config.centralApiUrl, apiKey: config.apiKey }), config.nodeId,
        process.env.COCOA_NODE_SOURCE ?? 'subzero');
      const published = await worker.tick();
      process.send?.({ id, result: { published } });
    } else throw new Error('unsupported');
  } catch {
    // Provider responses, keys, and document content never go to process logs.
    process.send?.({ id, error: 'Private node operation failed' });
  } finally { busy = false; }
});
process.on('disconnect', () => process.exit(0));
