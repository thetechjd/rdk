import { QUERY_CACHE_MAX_ENTRIES, QUERY_CACHE_TTL_SECONDS } from './pipeline.constants.js';

interface Entry { value: string; expiresAt: number }

export class QueryCache {
  private entries = new Map<string, Entry>();

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) { this.entries.delete(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + QUERY_CACHE_TTL_SECONDS * 1000 });
    while (this.entries.size > QUERY_CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void { this.entries.clear(); }
}

export const queryCache = new QueryCache();
