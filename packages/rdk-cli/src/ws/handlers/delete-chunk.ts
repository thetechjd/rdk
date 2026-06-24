// packages/rdk-cli/src/ws/handlers/delete-chunk.ts

import { loadConfig } from '../../config.js';
import { pushChunkDeleted } from '../events.js';

export async function deleteChunkHandler(data: unknown): Promise<{ deleted: boolean; existedLocally: boolean; chunkId: string; dbPath: string }> {
  const { chunkId } = data as { chunkId: string };

  const { LocalStore } = await import('@rdk/core');
  const config = loadConfig();

  // Remove from RDK Central first (best-effort — proceed even if it fails)
  try {
    const authRes = await fetch(`${config.centralApiUrl}/api/v1/nodes/auth`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (authRes.ok) {
      const { jwtToken } = await authRes.json() as { jwtToken: string };
      await fetch(`${config.centralApiUrl}/api/v1/chunks/${chunkId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwtToken}` },
        signal: AbortSignal.timeout(5000),
      });
    }
  } catch {
    // Continue with local deletion even if central is unreachable
  }

  // Delete is intentionally NOT gated on the local row existing. The dashboard
  // intent is "remove this chunk from the network/Central view"; if this node
  // no longer has the row (e.g. re-indexing changed content hashes), there is
  // simply nothing local to delete — that is not a failure.
  const store = new LocalStore();
  const dbPath = typeof store.getDatabasePath === 'function'
    ? store.getDatabasePath()
    : '(unknown local store path)';
  const existedLocally = store.deleteChunk(chunkId);
  store.close();

  pushChunkDeleted(chunkId);

  return { deleted: true, existedLocally, chunkId, dbPath };
}
