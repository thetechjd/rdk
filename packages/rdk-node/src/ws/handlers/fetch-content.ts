// packages/rdk-node/src/ws/handlers/fetch-content.ts
// The node is the authoritative content store. RDK Central holds only embeddings
// and metadata; when a chunk is retrieved, Central asks the owning node for the
// content in real time via this handler. See ARCH_CORRECTION_DESIGN.md.
//
// Public chunks → plaintext. Private chunks → ciphertext (we never decrypt here;
// the requesting team member decrypts locally with the shared vault key, so
// Central never sees private plaintext).

interface FetchContentResult {
  chunkId: string;
  isPublic?: boolean;
  content?: string;
  contentCiphertext?: string;
  available: boolean;
}

export async function fetchContentHandler(data: unknown): Promise<{ chunks: FetchContentResult[] }> {
  const { chunkIds } = data as {
    chunkIds: string[];
    requesterId: string;
    requesterTeamKeyId: string | null;
  };

  // Access control is Central's responsibility: it verifies the requester has
  // team access (it holds team membership) before issuing this command. We trust
  // that verification and simply serve the stored content.

  const { LocalStore } = await import('@rdk/core');
  const store = new LocalStore();
  try {
    const chunks: FetchContentResult[] = [];

    for (const chunkId of chunkIds ?? []) {
      const chunk = store.getChunk(chunkId);

      if (!chunk) {
        // Chunk no longer exists locally — Central's index is stale.
        chunks.push({ chunkId, available: false });
        continue;
      }

      if (chunk.isPublic) {
        // Public: content is stored as plaintext at rest.
        chunks.push({ chunkId, isPublic: true, content: chunk.content, available: true });
      } else {
        // Private: content is stored encrypted at rest (when a vault key is
        // configured). Hand over the ciphertext as-is — no decryption.
        chunks.push({ chunkId, isPublic: false, contentCiphertext: chunk.content, available: true });
      }
    }

    return { chunks };
  } finally {
    store.close();
  }
}
