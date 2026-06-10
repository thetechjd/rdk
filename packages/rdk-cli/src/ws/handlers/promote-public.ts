// packages/rdk-cli/src/ws/handlers/promote-public.ts
// Decrypts a PRIVATE chunk locally and re-uploads it to RDK Central as PUBLIC.
// This closes the V1 gap: Central cannot make a chunk public without the plaintext,
// which only the local node can produce by decrypting with the vault key.

import { loadConfig } from '../../config.js';
import { getWsClient } from '../client.js';

export async function promotePublicHandler(data: unknown): Promise<{ promoted: boolean; chunkId: string }> {
  const { chunkId } = data as { chunkId: string };

  const { LocalStore, decrypt, keyFromHex } = await import('@rdk/core');
  const config = loadConfig();

  if (!config.vaultKeyHex) throw new Error('No vault key configured — run rdk init');

  const store = new LocalStore();
  try {
    const chunk = store.getChunk(chunkId);
    if (!chunk) throw new Error('Chunk not found in local cache');
    if (!chunk.isEncrypted) throw new Error('Chunk is not encrypted — may already be public');

    const vaultKey = keyFromHex(config.vaultKeyHex);
    const plaintext = decrypt(chunk.content, vaultKey);
    const sizeBytes = Buffer.byteLength(plaintext, 'utf8');

    const embedding = store.getEmbedding(chunkId);
    if (!embedding) throw new Error('Embedding not found for chunk');

    // Authenticate with central
    const authRes = await fetch(`${config.centralApiUrl}/api/v1/nodes/auth`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!authRes.ok) throw new Error(`Auth failed: HTTP ${authRes.status}`);
    const { jwtToken } = await authRes.json() as { jwtToken: string };

    // Re-upload as public plaintext
    const syncRes = await fetch(`${config.centralApiUrl}/api/v1/chunks/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtToken}`,
      },
      body: JSON.stringify({
        chunks: [{
          chunkHash: chunkId,
          title: chunk.title,
          summary: chunk.summary,
          domain: chunk.domain ?? config.domain,
          categories: chunk.categories,
          embedding: Array.from(embedding),
          isPublic: true,
          isEncrypted: false,
          freshnessAt: new Date().toISOString(),
          sizeBytes,
        }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!syncRes.ok) throw new Error(`Upload failed: HTTP ${syncRes.status}`);

    // Update local store: store plaintext, flip flags
    const { createdAt, updatedAt, ...chunkData } = chunk;
    void createdAt; void updatedAt;
    store.saveChunk({ ...chunkData, content: plaintext, isPublic: true, isEncrypted: false }, embedding);
    store.markSynced(chunkId);

    // Notify Central the promotion is complete
    const wsClient = getWsClient();
    wsClient?.send({ type: 'chunk.public_complete', data: { chunkId, sizeBytes } });

    return { promoted: true, chunkId };
  } finally {
    store.close();
  }
}
