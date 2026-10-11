// One process and one encrypted vault per project. No tenant-supplied code runs here.
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { configExists, loadConfig, saveConfig } from '../packages/rdk-node/dist/config.js';
import { registerNode } from '../packages/rdk-node/dist/register-node.js';
import { NodeController, CentralClient, SubzeroSupportSync } from '../packages/rdk-node/dist/index.js';
let node;
let busy = false;
process.on('message', async ({ id, action, body }) => {
  if (busy) { process.send?.({ id, error: 'busy' }); return; }
  busy = true;
  try {
    if (!node) {
      if (!configExists()) {
        const vaultPath = join(process.env.RDK_HOME, 'vault');
        await mkdir(vaultPath, { recursive: true, mode: 0o700 });
        const registered = await registerNode({ centralApiUrl: process.env.RDK_CENTRAL_URL, email: body.email, displayName: `Cocoa ${process.env.COCOA_NODE_SCOPE}`, domain: 'support' });
        saveConfig({ ...registered, centralApiUrl: process.env.RDK_CENTRAL_URL, ownerEmail: body.email, plan: 'free', vaultAdapter: 'filesystem', vaultPath, domain: 'support', walletChain: 'base', mcpPort: 0, createdAt: new Date().toISOString(), vaultKeyHex: randomBytes(32).toString('hex'), defaultVisibility: 'private', autoSync: true });
      }
      node = new NodeController({ logger: () => {} });
      await node.start();
    }
    const config = loadConfig();
    if (action === 'ensure') process.send?.({ id, result: { nodeId: config.nodeId, nodeApiKey: config.apiKey } });
    else if (action === 'sync') {
      const worker = new SubzeroSupportSync(body.apiUrl, body.token, body.projectId, node,
        new CentralClient({ centralApiUrl: config.centralApiUrl, apiKey: config.apiKey }), config.nodeId);
      const published = await worker.tick();
      process.send?.({ id, result: { published } });
    } else throw new Error('unsupported');
  } catch {
    // Provider responses, keys, and document content never go to process logs.
    process.send?.({ id, error: 'Private node operation failed' });
  } finally { busy = false; }
});
process.on('disconnect', () => process.exit(0));
