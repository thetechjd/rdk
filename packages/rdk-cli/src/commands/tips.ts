// packages/rdk-cli/src/commands/tips.ts
// Tips are Tier 4 — ethers only installed when user explicitly enables tips.

import { loadConfig, updateConfig } from '../config.js';
import { requireDep } from '../require-dep.js';
import { t, mark, divider } from '../theme.js';

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SUPPORTED_CHAINS = ['base', 'ethereum', 'polygon'];

/** rdk wallet <address> [--chain base] — set the payout wallet for tip earnings. */
export async function setWallet(address: string, opts: { chain?: string } = {}): Promise<void> {
  const addr = address.trim();
  if (!EVM_ADDRESS.test(addr)) {
    console.log(t.error('  Invalid wallet address — expected 0x followed by 40 hex characters.'));
    return;
  }
  const chain = (opts.chain ?? loadConfig().walletChain ?? 'base').toLowerCase();
  if (!SUPPORTED_CHAINS.includes(chain)) {
    console.log(t.error(`  Unsupported chain "${chain}". Choose one of: ${SUPPORTED_CHAINS.join(', ')}`));
    return;
  }
  updateConfig({ walletAddress: addr, walletChain: chain });
  console.log('');
  console.log(`  ${mark.ok()} Payout wallet set: ${t.body(addr)} ${t.dim(`(${chain})`)}`);
  console.log(t.dim('  Tip earnings accrue as USDC credit; withdraw to this wallet with rdk earnings:withdraw.'));
  console.log('');
}

export async function tipsEnable(): Promise<void> {
  console.log(t.heading('\nEnable RDK tip earnings\n'));
  console.log(t.dim('  Tips are on-chain USDC micropayments paid by other nodes'));
  console.log(t.dim('  when they retrieve knowledge you contributed to the network.\n'));

  const ready = await requireDep('ethers');
  if (!ready) return;

  const config = loadConfig();
  if (!config.walletAddress) {
    // Prompt for the wallet here instead of telling the user to hand-edit
    // config.json. Non-interactive (piped) runs print the manual fallback.
    const { input } = await import('../prompts.js');
    let address: string;
    try {
      address = await input({
        message: 'Your EVM wallet address (0x...) to receive tips:',
        validate: v => EVM_ADDRESS.test(v.trim()) || 'Enter a valid 0x EVM address (40 hex characters)',
      });
    } catch {
      console.log(t.warn('  No wallet set. Add one any time with: rdk wallet 0xYourAddress'));
      return;
    }
    const chain = (await input({ message: 'Chain:', default: config.walletChain ?? 'base' })).trim().toLowerCase();
    updateConfig({ walletAddress: address.trim(), walletChain: SUPPORTED_CHAINS.includes(chain) ? chain : 'base' });
    config.walletAddress = address.trim();
    config.walletChain = SUPPORTED_CHAINS.includes(chain) ? chain : 'base';
  }

  console.log(`  ${mark.ok()} Tips enabled`);
  console.log(`  Wallet: ${t.body(config.walletAddress)}`);
  console.log(`  Chain:  ${t.body(config.walletChain)}`);
  console.log(t.dim('  Tip amounts are calculated by the network based on retrieval quality.'));
  console.log('');
  console.log(t.dim('  Set RDK_WALLET_PRIVATE_KEY env var to enable auto-settlement.'));
  console.log(t.dim('  Tips queue locally and batch-settle hourly.'));
}

export async function tipsStatus(): Promise<void> {
  const config = loadConfig();
  const { LocalStore } = await import('@rdk/core');
  const store = new LocalStore();
  const pending = store.getPendingTipTotal();
  const pendingList = store.getPendingTips();
  store.close();

  console.log(t.heading('\nTip Status'));
  console.log(divider(40));
  console.log(`Wallet:       ${t.body(config.walletAddress ?? t.muted('not configured'))}`);
  console.log(`Chain:        ${t.body(config.walletChain)}`);
  console.log(`Pending:      ${t.body(`$${pending.toFixed(4)} USDC (${pendingList.length} tips)`)}`);
  console.log('');

  if (!(await isEthersInstalled())) {
    console.log(t.dim('  Run rdk tips:enable to activate on-chain settlement'));
  }
}

async function isEthersInstalled(): Promise<boolean> {
  try { await import('ethers' as string); return true; } catch { return false; }
}
