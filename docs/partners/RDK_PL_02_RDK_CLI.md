# RDK x ParlayLedger: RDK CLI Node (SPEC 02)

**Repo:** RDK monorepo, `packages/rdk-cli` (npm `@retrodeck/rdk`, command `rdk`). Shared node code (config, WS client, handlers, sync service) lives in `packages/rdk-node` and also runs in the desktop app; handlers go there.
**Depends on:** SPEC 00 and **RDK_PL_00A_AMENDMENTS.md (wins on conflict)**.
**Delivers:** `rdk link`, `rdk init --link`, `rdk partners`, the `command.partner_job` handler, external refs on sync, wallet sync to Central, and a localhost query API for the ParlayLedger query node.
Phase 0 is done: `packages/rdk-cli/docs/PHASE0_PARTNERS.md`.

---

## Phase 1: Commands

### `rdk link <code>`
1. Requires an initialized, registered node. If none (or an offline `local-*` node): print `No node found. Run: rdk init --link <code>` and exit 1.
2. Normalize the code (uppercase, strip spaces and dashes), call Central `POST /api/v1/nodes/partner-link { pairCode }` with the node JWT (00A C1).
3. On success write to config (and store `accountId` as `retrodeckUserId`):
   ```json
   "partners": {
     "parlayledger": {
       "name": "ParlayLedger",
       "linkId": "lnk_...",
       "enabled": true,
       "allowedJobTypes": ["publish_doc", "unpublish_doc", "ping"],
       "linkedAt": "2026-10-11T18:00:00Z"
     }
   }
   ```
   No field in this block is secret.
4. Create the managed folder `~/.rdk/partners/parlayledger/` (mode 700), honoring `RDK_HOME`.
5. Print exactly:
   ```
   Linked to ParlayLedger.
   Picks and strategies you publish on ParlayLedger will be saved to this node and shared on the RDK network.
   Keep `rdk mcp:serve` running so your publications can be retrieved and you can earn.
   ```
6. Errors print the platform message and exit 1. Map codes: `pair_code_invalid` → `That code is not valid. Get a new one from your ParlayLedger dashboard.`; `pair_code_expired` → `That code expired. Get a new one from your ParlayLedger dashboard.`; `pair_code_used` → `That code was already used. Get a new one from your ParlayLedger dashboard.`; `node_owned_by_other_account` → platform message verbatim.

### `rdk init --link <code>`
Runs the init flow, then `rdk link <code>` with the same code. If init fails, do not attempt the link.
**Important:** a user whose RetroDeck account was provisioned by ParlayLedger does not know a password. When `--link` is given, init must be able to **skip the RetroDeck account sign-in/registration step entirely**: register the node with Central, authenticate, save config, then link. Pairing binds the node to the account (00A C1), so no RetroDeck credentials are needed. Keep all other init behavior (vault setup, autostart, MCP config) unchanged. It must work non-interactively too (`--link` with `-y`).

### `rdk partners`
- `rdk partners` lists linked partners: name, status (enabled/disabled), linked date, managed doc count.
- `rdk partners disable parlayledger` sets `enabled: false`; the handler then rejects jobs with `partner_disabled`. Docs stay.
- `rdk partners enable parlayledger` sets it back.
- `rdk partners remove parlayledger --delete-docs` unpublishes and deletes every managed doc for the partner, then removes the block. Without `--delete-docs`, keeps the files and their chunks and only removes the block.
Register both grouped and colon forms consistent with the existing style in `cli.ts`.

---

## Phase 2: `command.partner_job` handler
File `packages/rdk-node/src/ws/handlers/partner-job.ts`, registered as `command.partner_job` in the handler map. Add types to the protocol file. Wire shape and error passthrough per 00A C2 (the client must forward a thrown error's `.code`).

Gate (in order, each failure throws with the code):
1. `config.partners[partnerId]` exists → else `partner_not_linked`.
2. `enabled === true` → else `partner_disabled`.
3. `jobType` in `allowedJobTypes` → else `job_type_not_allowed`.
4. Payload validates against the SPEC 01 Phase 4 schema → else `invalid_payload`.

### `publish_doc`
1. Recompute SHA-256 of `payload.markdown` UTF-8 bytes; mismatch → `content_hash_mismatch`.
2. Size over 32,768 bytes → `doc_too_large`.
3. `filename` must equal `${ref}.md` and match the regex; resolve inside `~/.rdk/partners/<partnerId>/` and refuse anything outside it → `invalid_filename`.
4. `payload.pin === true` → `pinning_unavailable` (do not write or index).
5. Idempotency: if the file exists with the same hash and its chunks are synced, return the stored result and do nothing else.
6. Write atomically (temp file in same folder, fsync, rename).
7. Index through `RDKIndexer.indexDocument` with `isPublic: true`, the payload `categories` and `domain`, absolute `sourcePath`, `sourceAdapter: 'partner:<partnerId>'`, and `externalPartner = partnerId`, `externalRef = ref` on every chunk. Extend `IndexResult` (or look up after) so chunk hashes are known.
8. Map failures: index rate limit → `rate_limited` (transient); Central rejecting for plan limit → `plan_limit_reached`.
9. Sync and return `{ ref, contentHash, chunkHashes, chunkIds, indexedAt }` (`chunkIds` = `chunkHashes`).

### `unpublish_doc`
1. Locate `~/.rdk/partners/<partnerId>/<ref>.md`. Missing (and no chunks for it) → `{ ref, alreadyRemoved: true }`.
2. Delete its chunks on Central (`SyncService.deleteOnCentral`) and locally, **delete the local `documents` row too** (add `LocalStore.deleteDocument`; otherwise `fetch_document` keeps serving it), then delete the file.
3. Return `{ ref, removedChunkHashes: [...] }`.

### `ping`
Return `{ cliVersion, serving, publicChunks, partnerDocs }`. `cliVersion` is injected by the host (CLI version or desktop version); `@rdk/node` must not guess. `serving` is true (the handler only runs when a WS session is up).

### Rules
- Never read or return any file outside the managed partner folder.
- Never change visibility, wallet, plan, keys or config other than writing the managed doc.
- Log every job to `~/.rdk/logs/partner-jobs.log` (honor `RDK_HOME`) as one JSON line `{ at, jobId, partnerId, jobType, ref, ok, code }`. Never log markdown bodies.
- Managed partner docs must never be picked up, duplicated or deleted by vault adapters / vault re-index (they sit under a dot-path; add an explicit guard anyway in case `vaultPath` contains `~/.rdk`).

---

## Phase 3: External refs on sync
- Local SQLite `chunks` gains `external_partner` and `external_ref` (existing idempotent ALTER pattern + CREATE TABLE + saveChunk + rowToChunk + StoredChunk).
- All three sync payload builders include `externalPartner` and `externalRef` when set (00A C3).
- A full re-sync preserves both fields.
- `rdk vault:search` results show `[ParlayLedger]` before the title for managed docs.

## Phase 3b: Wallet sync (00A C6)
`rdk wallet <address>` keeps writing local config and additionally calls Central `PATCH /api/v1/nodes/me/wallet` best effort (warn, do not fail, when offline). Add `syncWalletToCentral` to whatever shared module fits.

---

## Phase 4: Localhost query API (for the ParlayLedger query node)
`rdk api:serve --port 7841 --token-file <path>`
- Binds to `127.0.0.1` only; refuses any other host option.
- Every request needs `Authorization: Bearer <token>` matching the token file contents (trimmed). Token file mode must be 600 (no group/other bits), else refuse to start.
- Runs alongside `rdk mcp:serve` under PM2. Does not open the WS session (00A C5).

`POST /v1/query`
```json
{ "q": "NBA unders when both teams are on no rest", "topK": 8, "tiers": ["network"],
  "filters": { "externalPartner": "parlayledger", "attestedStatus": ["verified_winning", "graded"], "categories": ["basketball"] },
  "maxTipUsdc": 0.25, "requestId": "plq_01J9..." }
```
- `tiers` defaults to `["network"]`; `"private"` allowed only for this node's own vault.
- Embeds `q` with the node's model, runs the two-phase flow with `filters` and the tip ceiling per 00A C5.
- Response:
  ```json
  { "requestId": "plq_...", "queryId": "<Central queryId>", "tipSpentUsdc": 0.18,
    "results": [ { "chunkId": "...", "nodeId": "...", "title": "...", "summary": "...", "content": "...",
      "score": 0.83, "tipPaidUsdc": 0.06, "categories": ["..."],
      "externalRef": { "partner": "parlayledger", "ref": "pub_..." },
      "attestation": { "kind": "strategy", "status": "verified_winning", "record": { }, "signedAt": "..." },
      "publisherRecord": { }, "skippedReason": null } ] }
  ```
- `GET /v1/health` → `{ ok, nodeId, wsConnected, walletBalanceUsdc }` (`wsConnected` may report whether a sibling `mcp:serve` session is present via the existing local presence file; `walletBalanceUsdc` = the node account's spendable RetroDeck balance if obtainable, else null).
- Errors: `401 unauthorized`, `422 invalid_request`, `503 central_unreachable`, `402 wallet_insufficient` (returns results fetched so far).

---

## Phase 5: Tests and acceptance
1. `rdk link` with valid, invalid, expired and used codes prints the exact strings above.
2. `rdk init --link` on a clean `RDK_HOME` creates a node and links it in one run, without RetroDeck credentials.
3. `publish_doc` writes the file, indexes it public with external refs, and is idempotent on replay.
4. Hash mismatch, oversized doc, path traversal filename (`../../x.md`), disabled partner and disallowed job type are each rejected with the right code, and nothing is written.
5. `unpublish_doc` removes chunks, the documents row and the file, and is idempotent.
6. A vault re-index does not touch managed partner docs.
7. `api:serve` refuses to bind to `0.0.0.0`, refuses a world-readable token file, rejects a bad token, and stops fetching at the tip cap.
8. `partner-jobs.log` never contains markdown text.
9. The WS client forwards handler error codes in `error.code`.
Plus SPEC 00 section 15 checks on changed CLI output strings.

**Release:** bump minor version in `packages/rdk-cli/package.json`. Changelog line: `Added rdk link for ParlayLedger and other partner apps.` **Do not publish** to npm/brew/curl and do not push; Kevan signs off first. Android: no Android app exists in this workspace; skip.
