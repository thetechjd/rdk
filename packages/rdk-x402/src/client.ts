// packages/rdk-x402/src/client.ts
// On-chain USDC micropayment tips for RDK knowledge retrieval.
// ethers.js is an optional dep — imported lazily on first tip settlement only.
// Tier 4: only loaded when user runs `rdk tips:enable`.

import type { LocalStore, TipQueueEntry } from '@rdk/core';

export const AUTONOMOUS_THRESHOLD_USDC = 0.05;
export const BATCH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const BATCH_TRIGGER_USDC = 1.00;

const USDC_CONTRACTS: Record<string, string> = {
  base:     '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  polygon:  '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
};

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
];

const RPC_URLS: Record<string, string> = {
  base:     'https://mainnet.base.org',
  ethereum: 'https://cloudflare-eth.com',
  polygon:  'https://polygon-rpc.com',
};

export interface TipConfig {
  privateKey: string;
  centralApiUrl: string;
  centralApiKey: string;
  defaultChain: string;
}

export class X402Client {
  private config: TipConfig;
  private store: LocalStore;
  private settling = false;

  constructor(config: TipConfig, store: LocalStore) {
    this.config = config;
    this.store = store;
  }

  /** Queue a tip after a successful network retrieval */
  async payForRetrieval(opts: {
    chunkId: string;
    providerNodeId: string;
    amountUsdc: number;
    chain?: string;
  }): Promise<{ queued: boolean; txHash?: string }> {
    const chain = opts.chain ?? this.config.defaultChain;

    this.store.enqueueTip({
      chunkId: opts.chunkId,
      providerNodeId: opts.providerNodeId,
      amountUsdc: opts.amountUsdc,
      chain,
    });

    // Trigger immediate batch if we've crossed the $1.00 threshold
    const pendingTotal = this.store.getPendingTipTotal();
    if (pendingTotal >= BATCH_TRIGGER_USDC) {
      setImmediate(() => this.settleBatch().catch(console.error));
    }

    return { queued: true };
  }

  /** Batch-settle all pending tips. Called hourly or when threshold crossed. */
  async settleBatch(): Promise<{ settled: number; failed: number; totalUsdc: number }> {
    if (this.settling) return { settled: 0, failed: 0, totalUsdc: 0 };
    this.settling = true;

    let settled = 0;
    let failed = 0;
    let totalUsdc = 0;

    try {
      const pending = this.store.getPendingTips();
      if (pending.length === 0) return { settled: 0, failed: 0, totalUsdc: 0 };

      // Group by providerNodeId + chain to minimize on-chain transactions
      const groups = new Map<string, TipQueueEntry[]>();
      for (const tip of pending) {
        const key = `${tip.providerNodeId}:${tip.chain}`;
        const group = groups.get(key) ?? [];
        group.push(tip);
        groups.set(key, group);
      }

      for (const [, tips] of groups) {
        const batchAmount = tips.reduce((s, t) => s + t.amountUsdc, 0);
        if (batchAmount < 0.001) continue; // skip micro-batches below gas cost

        const chain = tips[0].chain;
        const providerNodeId = tips[0].providerNodeId;

        try {
          const txHash = await this.sendUsdc(providerNodeId, batchAmount, chain);
          if (txHash) {
            for (const tip of tips) {
              this.store.settleTip(tip.id, txHash);
              await this.recordOnCentral(tip.chunkId, txHash, tip.amountUsdc, chain);
            }
            settled += tips.length;
            totalUsdc += batchAmount;
          }
        } catch {
          for (const tip of tips) this.store.failTip(tip.id);
          failed += tips.length;
        }
      }
    } finally {
      this.settling = false;
    }

    return { settled, failed, totalUsdc };
  }

  /** Start hourly background settlement loop */
  startSettlementLoop(): ReturnType<typeof setInterval> {
    return setInterval(() => {
      if (this.store.getPendingTipTotal() > 0) {
        this.settleBatch().catch(console.error);
      }
    }, BATCH_INTERVAL_MS);
  }

  // ── Private: on-chain settlement ──────────────────────────────────────────

  private async sendUsdc(
    providerNodeId: string,
    amountUsdc: number,
    chain: string,
  ): Promise<string | null> {
    const toAddress = await this.getProviderWallet(providerNodeId);
    if (!toAddress) return null;

    const usdcAddress = USDC_CONTRACTS[chain];
    if (!usdcAddress) throw new Error(`Chain not supported: ${chain}`);

    if (!this.config.privateKey) {
      throw new Error('No wallet private key. Set RDK_WALLET_PRIVATE_KEY env var.');
    }

    // Lazy-load ethers — only runs if tips are actually being settled
    const ethers = await this.loadEthers();

    const rpcUrl = process.env[`${chain.toUpperCase()}_RPC_URL`] ?? RPC_URLS[chain];
    if (!rpcUrl) throw new Error(`No RPC URL for chain: ${chain}`);

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(this.config.privateKey, provider);
    const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, wallet);

    // USDC: 6 decimals
    const amount = BigInt(Math.round(amountUsdc * 1_000_000));
    const tx = await (usdc['transfer'] as (to: string, amount: bigint) => Promise<{ wait: () => Promise<{ hash: string } | null> }>)(toAddress, amount);
    const receipt = await tx.wait();
    return receipt?.hash ?? null;
  }

  private async getProviderWallet(providerNodeId: string): Promise<string | null> {
    try {
      const res = await fetch(
        `${this.config.centralApiUrl}/api/v1/nodes/${providerNodeId}/wallet`,
        { headers: { Authorization: `Bearer ${this.config.centralApiKey}` } },
      );
      if (!res.ok) return null;
      const data = await res.json() as { walletAddress?: string };
      return data.walletAddress ?? null;
    } catch {
      return null;
    }
  }

  private async recordOnCentral(
    chunkId: string,
    txHash: string,
    amountUsdc: number,
    chain: string,
  ): Promise<void> {
    await fetch(`${this.config.centralApiUrl}/api/v1/tips/record`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.centralApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ queryId: '', chunkId, txHash, amountUsdc, chain }),
    });
  }

  // Lazy ethers loader — returns the ethers namespace, not { ethers: ... }
  private async loadEthers(): Promise<typeof import('ethers')> {
    try {
      return await import('ethers');
    } catch {
      throw new Error(
        'ethers not installed.\n' +
        'Run: rdk tips:enable  (installs automatically)\n' +
        'Or:  npm install ethers',
      );
    }
  }
}
