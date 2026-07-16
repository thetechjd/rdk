// packages/rdk-node/src/ws/handlers/promote-public.ts
// Promotes a PRIVATE chunk to PUBLIC. The node is the authoritative content store,
// so promotion is a local operation: decrypt the chunk and re-store it as plaintext
// in our OWN database, then flip the visibility flag. Content never moves to Central
// — we only notify Central that the chunk's visibility changed so it can update its
// metadata. See ARCH_CORRECTION_DESIGN.md.

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
    if (!chunk) {
      const dbPath = typeof store.getDatabasePath === 'function'
        ? store.getDatabasePath()
        : '(unknown local store path)';
      throw new Error(`Chunk not found in local store: ${chunkId} (db: ${dbPath})`);
    }
    if (chunk.isPublic) throw new Error('Chunk is already public');
    if (!chunk.isEncrypted) throw new Error('Chunk is not encrypted — cannot promote');

    const embedding = store.getEmbedding(chunkId);
    if (!embedding) throw new Error('Embedding not found for chunk');

    // Decrypt the content and re-store it as plaintext LOCALLY. The content moves
    // from the encrypted form to plaintext in our own database — it does NOT go to
    // Central. Central keeps the embedding it already has and only learns that the
    // visibility flag changed.
    const vaultKey = keyFromHex(config.vaultKeyHex);
    const plaintext = decrypt(chunk.content, vaultKey);

    const { createdAt, updatedAt, ...chunkData } = chunk;
    void createdAt; void updatedAt;
    store.saveChunk({ ...chunkData, content: plaintext, isPublic: true, isEncrypted: false }, embedding);

    // Notify Central to update the visibility flag (metadata only, no content).
    const wsClient = getWsClient();
    wsClient?.send({ type: 'chunk.visibility_changed', data: { chunkId, isPublic: true } });

    return { promoted: true, chunkId };
  } finally {
    store.close();
  }
}
