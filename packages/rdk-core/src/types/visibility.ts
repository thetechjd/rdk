// packages/rdk-core/src/types/visibility.ts
//
// THE canonical content-state model, shared by every RDK surface (desktop, CLI,
// MCP; the browser dashboard mirrors these exact wire strings in its own
// lib/visibility.ts). One vocabulary everywhere:
//
//   local   — on this machine only. Unindexed files, and local_only chunks
//             (e.g. knowledge saved from a network query). Never on the network.
//   private — indexed + AES-256-GCM encrypted on the network. Only the owner
//             (and team members holding the vault key) can read it. Free to
//             query for its owner.
//   public  — indexed as plaintext on the network. Earns tips when retrieved
//             by OTHERS (never by its own account). Versioned: an edit mints a
//             new immutable version; old versions freeze with history intact.
//
// Canonical verbs (use these words in every UI/CLI/API surface):
//   index     — file → private (encrypted on the network)
//   publish   — private → public (was: "make public", "promote")
//   unpublish — retire a public chunk: stop serving it from now on; earnings
//               history is preserved; copies other nodes already saved are
//               beyond recall (per-version immutability is the real boundary)
//   save      — network result → local (this machine only)

/** State of a single chunk. */
export type ChunkState = 'local' | 'private' | 'public';

/** State of a FILE, aggregated over its chunks. 'mixed' = chunks in more than
 *  one state — shown honestly instead of collapsing to 'public'. */
export type FileState = ChunkState | 'mixed';

/** Derive a chunk's state from its stored flags. */
export function chunkState(c: { isPublic: boolean; isLocalOnly?: boolean }): ChunkState {
  if (c.isPublic) return 'public';
  if (c.isLocalOnly) return 'local';
  return 'private';
}

/**
 * Aggregate a file's state from its (live, non-superseded) chunks.
 * No chunks → 'local' (an unindexed file); uniform chunks → that state;
 * anything else → 'mixed'.
 */
export function fileState(chunks: Array<{ isPublic: boolean; isLocalOnly?: boolean }>): FileState {
  if (chunks.length === 0) return 'local';
  const states = new Set(chunks.map(chunkState));
  return states.size === 1 ? [...states][0] : 'mixed';
}
