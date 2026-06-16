# Architecture Correction — Design Foundation
## Cross-cutting reference for all per-app specs

---

## Why This Exists

Earlier specs (V1 through V3) treated RDK Central as a STORAGE layer —
it held chunk content (public as plaintext, private as ciphertext).
This contradicts the core vision: RDK is meant to be a decentralized
knowledge network (IPFS-like) where node operators store their own
content and earn tips when it's retrieved. If Central stores everyone's
content, it's not decentralized — it's a centralized database with extra
steps, and it doesn't scale economically.

This document defines the corrected architecture. Every per-app spec in
this batch references it. Read it first.

---

## The Corrected Model

```
            CENTRAL HOLDS                  NODES HOLD
            ─────────────                  ──────────
            all embeddings                 all chunk content (authoritative)
              (public + private)           vault files (LOCAL)
            chunk metadata                 local SQLite index
            node registry                  vault encryption keys
            team membership
            tip ledger
            routing table
            PINNED content (opt-in, paid)
```

**The one-line principle**: Central is a routing directory that holds
embeddings and metadata, never content — except content that operators
explicitly pay to pin for availability.

---

## What Central Holds vs Doesn't

### Central HOLDS

- **Embeddings** for all chunks, public and private. Embeddings are the
  routing index — Central needs them to answer "who has a chunk similar
  to this query." A 384-dim vector is a mathematical representation, not
  the content. Holding it is necessary for the network to function.
- **Metadata**: title (public only), categories, size, visibility flag,
  retrieval count, owning node, cluster assignment, UMAP coords.
- **Node registry**: which nodes exist, their domains, online status.
- **Team membership**: who can decrypt whose private chunks.
- **Tip ledger**: the accounting of who earned what.
- **Pinned content**: full content for chunks the operator paid to pin.
  Public pins = plaintext. Private pins = ciphertext (Central still
  can't read them).

### Central does NOT hold

- **Chunk content** (the actual text), unless pinned. Not public
  plaintext, not private ciphertext. Content lives on the owning node.
- **Vault files** (LOCAL). Never leave the user's machine.
- **Vault keys**. Never leave the user's machine.

---

## Query / Retrieval Flow (Corrected)

```
1. Agent (or local node) sends a query
2. Central embeds the query (or receives the embedding)
3. Central runs similarity search over its embedding index
4. Central gets candidate chunk matches with their owning node IDs
5. For each candidate, Central checks visibility + access:
   - public  → anyone may retrieve
   - private → only owner + team members with key access may retrieve
6. Central fetches content:
   - If chunk is PINNED → serve from Central's pin cache
   - Else if owning node is ONLINE → request content over WebSocket
   - Else (offline, not pinned) → SKIP this chunk, try next-best match
7. Central returns available content to the caller
8. Tip accrues to the owning node operator
```

Key points:
- **Embeddings searched centrally, content fetched from nodes.**
- **Offline + unpinned = silently skipped.** Next-best available match
  is returned. No error, no stall. Tips incentivize uptime.
- **Private routing works across nodes** because Central holds private
  embeddings and team membership. A team member's query can match
  another team member's private chunk; Central routes the content fetch
  to the owning node, which returns ciphertext; the requesting node
  decrypts with the shared vault key. Central never decrypts.

---

## Content-Fetch Protocol

New WebSocket command from Central to a node, requesting chunk content.

### Central → Node

```json
{
  "type": "command.fetch_content",
  "id": "fetch_abc123",
  "data": {
    "chunkIds": ["chunk_1", "chunk_2"],
    "requesterId": "user_xyz",       // for private access verification
    "requesterTeamKeyId": "key_123"  // null for public-only requests
  }
}
```

### Node → Central (reply)

```json
{
  "type": "ack",
  "replyTo": "fetch_abc123",
  "data": {
    "chunks": [
      {
        "chunkId": "chunk_1",
        "isPublic": true,
        "content": "the actual plaintext content...",
        "available": true
      },
      {
        "chunkId": "chunk_2",
        "isPublic": false,
        "contentCiphertext": "base64-encrypted-blob...",
        "available": true
      }
    ]
  }
}
```

Notes:
- For public chunks, the node returns plaintext. Central forwards it to
  the caller and may cache briefly (see "Hot cache" below).
- For private chunks, the node returns ciphertext. Central forwards the
  ciphertext to the requesting node, which decrypts locally. Central
  never sees plaintext for private content.
- The node verifies its own copy still exists; if the chunk was deleted
  locally but Central's index is stale, `available: false` is returned
  and Central prunes its index entry.

### Latency Budget

Every network retrieval now involves a Central → Node round-trip. Target:

- Node responds to fetch_content within 500ms (P95)
- Central applies a 2s hard timeout; on timeout, treat as offline/skip
- For multi-chunk queries, Central batches fetch requests per node
  (one WebSocket message with multiple chunkIds, not N messages)

### Hot Cache (Ephemeral, Not Storage)

Central MAY hold a short-lived in-memory LRU cache of recently-fetched
PUBLIC content (e.g. 60-second TTL) to avoid hammering a node when the
same popular chunk is retrieved repeatedly. This is:

- **Public content only** — never private
- **In-memory only** — never persisted to disk or DB
- **Short TTL** — measured in seconds, an optimization not a store
- **Distinct from pinning** — pinning is durable, paid, opt-in; the hot
  cache is ephemeral, free, automatic

The hot cache does not change the "Central doesn't store content" model
— it's a transient performance optimization, gone within a minute.

---

## Data Model Migration

### chunks table — drop content columns

```sql
-- Migration: remove content storage from Central

ALTER TABLE chunks DROP COLUMN IF EXISTS content_plaintext;
ALTER TABLE chunks DROP COLUMN IF EXISTS content_ciphertext;

-- chunks now holds ONLY routing + metadata:
-- id, node_id, is_public, is_encrypted, embedding, title (public only),
-- categories, size_bytes, retrieval_count, total_tips_usdc,
-- umap_x, umap_y, cluster_id, cluster_label, created_at, last_retrieved_at
```

### New table — pinned_content

```sql
CREATE TABLE pinned_content (
  chunk_id UUID PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  node_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  is_public BOOLEAN NOT NULL,
  content_plaintext TEXT,          -- public pins only
  content_ciphertext TEXT,         -- private pins only
  size_bytes INT NOT NULL,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (is_public = true  AND content_plaintext IS NOT NULL AND content_ciphertext IS NULL) OR
    (is_public = false AND content_ciphertext IS NOT NULL AND content_plaintext IS NULL)
  )
);

CREATE INDEX idx_pinned_node ON pinned_content (node_id);
```

This is the ONLY place Central persists content, and only by explicit
paid consent (see pinning spec).

### Migration for existing production chunks

Production Central currently has ~3 chunks with content stored (the
user's test data). Migration plan:

1. Before dropping content columns, the owning node must have the
   content locally (it does — content originated there). Verify the
   local SQLite has all chunks Central knows about.
2. Drop the content columns. Central keeps embedding + metadata.
3. On next query, Central fetches content from the node via the new
   protocol. No data loss — content was always on the node too.

If any chunk exists on Central but NOT on the owning node (shouldn't
happen, but verify), export its content first and re-import to the node
before dropping columns.

---

## V3 Spec Audit — What Changes

The following items from earlier V3 specs assumed Central stored content.
Each per-app spec corrects its own, but here's the master list:

### RDK Central (DASHBOARD_V3_RDK_CENTRAL.md)

- `getKnowledgeMap` — returns chunks for VISUALIZATION. It returns
  metadata + UMAP coords ONLY. No content. (It never needed content —
  the map shows dots, not text. Confirm no content field leaks in.)
- `getClusterDetail` — returns `preview_text` (first 200 chars). Under
  the corrected model, Central doesn't have the text to preview. Either:
  (a) drop preview_text from the cluster endpoint, OR (b) fetch preview
  on-demand from the node. Recommend (a) for V3 — the cluster detail
  shows titles + metadata; clicking a chunk fetches full content live.
- `promote_public` command — was "node decrypts, re-uploads plaintext
  to Central." Corrected: node just flips its local is_public flag and
  notifies Central to update the visibility flag. Content stays on node.
  No re-upload.
- Tip events — unchanged (they're metadata, not content).

### RDK CLI (DASHBOARD_V3_RDK.md)

- `promote-public` handler — was "decrypt + upload plaintext to Central."
  Corrected: flip local is_public flag, send a lightweight
  `chunk.visibility_changed` event to Central (no content). The content
  was already on the node; nothing moves.
- NEW: `fetch_content` command handler — node must respond to Central's
  content requests. This is the load-bearing addition.

### RetroDeck API (DASHBOARD_V3_RETRODECK_API.md)

- Knowledge-map federation — passes through metadata only, no content.
- Promote-public endpoint — calls the corrected (no-upload) command.

### Dashboard (DASHBOARD_V3_DASHBOARD.md)

- Knowledge map — already only renders dots + metadata. No change needed
  to the visual; confirm it never requested content for the map view.
- Chunk detail panel (clicking a chunk) — NOW fetches content live via
  a new endpoint that triggers a Central → Node fetch. Previously it
  would have read content from Central directly.

---

## Terminology Correction

Earlier terminology specs said private chunks are "stored on the network
as ciphertext." Update to: private chunks are "indexed on the network
(embedding + metadata); content stays on your node, encrypted." The
distinction matters now — indexed ≠ stored.

Glossary update (TERMINOLOGY_GLOSSARY.md):

- PRIVATE: "Content stays on your node, encrypted. Central holds only
  the embedding and metadata for routing. Team members retrieve content
  directly from your node (decrypted with the shared key) when you're
  online, or from a pin cache if pinned."
- PUBLIC: "Content stays on your node as plaintext. Central holds the
  embedding and metadata. Retrieved from your node when online, or from
  a pin cache if pinned. Earns tips on retrieval."

---

## Implications Summary

1. **Central's storage footprint drops to embeddings + metadata + pins.**
   At scale this is the difference between storing everyone's documents
   (untenable) and storing vectors (tiny).
2. **The WebSocket gateway becomes load-bearing for retrieval**, not just
   events. Connection reliability and fetch latency now affect query
   quality directly.
3. **Offline nodes degrade gracefully** — their chunks are skipped, the
   next-best available match wins. Tips incentivize uptime. Pinning
   sells guaranteed availability.
4. **Embedding generation stays on nodes.** Earlier specs proposed
   server-side embedding for cloud publishing — that's dropped along
   with cloud-only publishing (see cloud MCP spec).
5. **The model is now genuinely decentralized** — intelligence lives on
   the nodes; Central routes.
