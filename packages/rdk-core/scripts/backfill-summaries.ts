/**
 * Gives pre-existing chunks the summary the indexer now always writes.
 *
 * Chunks indexed before extractive summaries landed have none, which costs
 * twice at query time: the reranker falls back to the full body (slow), and a
 * network peer sees an empty summary for them. Extractive only — no LLM, no
 * network, no cost.
 *
 * On demand, never automatic:
 *   node dist-scripts/backfill-summaries.js [dbPath]
 * Reads the vault key from ~/.rdk/config.json so encrypted chunks can be read;
 * without it they are counted and skipped rather than summarized as ciphertext.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LocalStore } from '../src/store/local-store.js';
import { extractiveSummary } from '../src/summarize.js';
import { decrypt, keyFromHex, type VaultKey } from '../src/crypto.js';

function loadVaultKey(): VaultKey | undefined {
  try {
    const configPath = path.join(os.homedir(), '.rdk', 'config.json');
    const { vaultKeyHex } = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { vaultKeyHex?: string };
    return vaultKeyHex ? keyFromHex(vaultKeyHex) : undefined;
  } catch {
    return undefined;
  }
}

const store = new LocalStore(process.argv[2]);
const vaultKey = loadVaultKey();
const pending = store.getChunksMissingSummary();

let written = 0;
let skippedEncrypted = 0;
let skippedEmpty = 0;

for (const chunk of pending) {
  let text = chunk.content;
  if (chunk.isEncrypted) {
    if (!vaultKey) { skippedEncrypted += 1; continue; }
    try {
      text = decrypt(chunk.content, vaultKey);
    } catch {
      // A summary of ciphertext is worse than none: it would be indexed,
      // reranked and served as if it were real content.
      skippedEncrypted += 1;
      continue;
    }
  }

  const summary = extractiveSummary(text);
  if (!summary.trim()) { skippedEmpty += 1; continue; }
  store.setChunkSummary(chunk.id, summary);
  written += 1;
}

console.error(
  `[rdk] summaries backfilled: ${written} written, ${skippedEncrypted} skipped (encrypted, no key), ` +
  `${skippedEmpty} skipped (nothing extractable), of ${pending.length} missing`,
);
