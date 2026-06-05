// packages/rdk-cli/src/commands/tips.ts
// Tips are Tier 4 — ethers only installed when user explicitly enables tips.

import { loadConfig } from '../config.js';
import { requireDep } from '../require-dep.js';
import { t, mark, divider } from '../theme.js';

export async function tipsEnable(): Promise<void> {
  console.log(t.heading('\nEnable RDK tip earnings\n'));
  console.log(t.dim('  Tips are on-chain USDC micropayments paid by other nodes'));
  console.log(t.dim('  when they retrieve knowledge you contributed to the network.\n'));

  const ready = await requireDep('ethers');
  if (!ready) return;

  const config = loadConfig();
  if (!config.walletAddress) {
    console.log(t.warn('No wallet configured.'));
    console.log(t.dim('  Add your EVM wallet address to ~/.rdk/config.json:'));
    console.log(t.dim('  "walletAddress": "0x..."'));
    console.log(t.dim('  "walletChain": "base"'));
    return;
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
