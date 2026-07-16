// packages/rdk-node/src/central-client.ts
//
// One UI-free HTTP client for RDK Central. Consolidates the auth/account/balance/
// earnings/team fetch calls that were scattered (and re-implemented) across the
// CLI's ora-wrapped command files and the desktop's inline fetches. Returns plain
// data or throws; no console, no prompts, no spinners.

export interface CentralClientConfig {
  centralApiUrl: string;
  /** Long-lived node API key — exchanged for a short-lived JWT for node endpoints. */
  apiKey?: string;
  /** RetroDeck account access token — for user/account endpoints. */
  accessToken?: string;
}

export interface EarningsSummary {
  totalUsdc: number;
  byDocument: { title: string; chunkId: string; earnedUsdc: number; retrievals: number }[];
  overTime: { date: string; usdc: number }[];
}

export interface AccountInfo {
  userId?: string;
  email?: string;
  plan?: string;
  walletAddress?: string;
}

export class CentralClient {
  private jwtToken?: string;
  private jwtExpiry = 0;

  constructor(private readonly config: CentralClientConfig) {}

  private get base(): string {
    return this.config.centralApiUrl.replace(/\/$/, '');
  }

  /** Exchange the node API key for a short-lived JWT (cached ~55min). */
  async getJwt(): Promise<string> {
    if (!this.config.apiKey) throw new Error('No API key configured for JWT exchange.');
    if (this.jwtToken && Date.now() < this.jwtExpiry) return this.jwtToken;
    const res = await fetch(`${this.base}/api/v1/nodes/auth`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Auth exchange failed: HTTP ${res.status}`);
    const { jwtToken } = (await res.json()) as { jwtToken: string };
    this.jwtToken = jwtToken;
    this.jwtExpiry = Date.now() + 55 * 60 * 1000;
    return jwtToken;
  }

  /** GET helper authorized with the RetroDeck access token. Returns null on non-2xx. */
  private async getWithToken<T>(path: string): Promise<T | null> {
    if (!this.config.accessToken) return null;
    const res = await fetch(`${this.base}${path}`, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  }

  async getAccount(): Promise<AccountInfo | null> {
    return this.getWithToken<AccountInfo>('/api/v1/users/me');
  }

  async getBalanceUsdc(): Promise<number | null> {
    const r = await this.getWithToken<{ balanceUsdc: number }>('/api/v1/balances/me');
    return r?.balanceUsdc ?? null;
  }

  async getEarnings(): Promise<EarningsSummary> {
    const r = await this.getWithToken<EarningsSummary>('/api/v1/tips/earnings');
    return r ?? { totalUsdc: 0, byDocument: [], overTime: [] };
  }

  /** Push chunk embeddings+metadata to Central (JWT-authorized). Returns counts. */
  async syncChunks(chunks: unknown[]): Promise<{ synced: number; errors: number }> {
    if (chunks.length === 0) return { synced: 0, errors: 0 };
    const jwt = await this.getJwt();
    const res = await fetch(`${this.base}/api/v1/chunks/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ chunks }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Sync failed: HTTP ${res.status}`);
    const r = (await res.json()) as { synced: number; errors: string[] };
    return { synced: r.synced, errors: r.errors.length };
  }
}
