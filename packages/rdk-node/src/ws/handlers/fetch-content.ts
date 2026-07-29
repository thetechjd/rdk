// packages/rdk-node/src/ws/handlers/fetch-content.ts
// The node is the authoritative content store. RDK Central holds only embeddings
// and metadata; when a chunk is retrieved, Central asks the owning node for the
// content in real time via this handler. See ARCH_CORRECTION_DESIGN.md.
//
// Public chunks → plaintext. Private chunks → ciphertext (we never decrypt here;
// the requesting team member decrypts locally with the shared vault key, so
// Central never sees private plaintext).

// One `content` field for both visibilities — Central's FetchedChunk reads only
// this name. Private content used to be sent as `contentCiphertext`, which
// nothing on the other side ever read, so team retrieval of private chunks
// always came back empty.
interface FetchContentResult {
  chunkId: string;
  isPublic?: boolean;
  content?: string;
  available: boolean;
}

// One store for the life of the process, not one per request.
//
// This handler used to `new LocalStore()` on every fetch — a fresh SQLite open,
// WAL pragma and schema-migration check — inside Central's fetch deadline. On a
// loaded or just-woken laptop that open alone could blow the budget, and Central
// reported the resulting timeout as the node being offline. The open is pure
// overhead: the file, the schema and the process are the same every time.
let storePromise: Promise<import('@rdk/core').LocalStore> | null = null;

async function sharedStore(): Promise<import('@rdk/core').LocalStore> {
  if (!storePromise) {
    storePromise = import('@rdk/core')
      .then(({ LocalStore }) => new LocalStore())
      // Don't cache a failed open — the next request should retry rather than
      // inherit a rejected promise forever.
      .catch((e) => { storePromise = null; throw e; });
  }
  return storePromise;
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

  const store = await sharedStore();
  {
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
        chunks.push({ chunkId, isPublic: false, content: chunk.content, available: true });
      }
    }

    return { chunks };
  }
}
