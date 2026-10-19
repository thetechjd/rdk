# RDK x ParlayLedger: Contract Amendments to SPEC 00-02 (00A)

**Status:** Binding. Approved by Kevan on 2026-10-11 after the Phase 0 reports.
Where this file conflicts with SPEC 00, 01 or 02, this file wins. Anything not mentioned here is unchanged.

## A. Decisions Kevan made

| # | Decision |
|---|---|
| A1 | The PartnersModule lives in **`apps/api`** (it owns users, plans, Stripe and login) and is modeled on the SubZero `integrations/*` code. Anything that needs the node socket, chunks or tips lives in **`apps/central-api`** behind new `/api/v1/internal/partners/*` routes, called through the existing `CentralClient` and `X-Internal-Secret`. |
| A2 | No BullMQ. Queues are **Postgres tables drained by `@nestjs/schedule` cron sweeps**: "the table is the truth, the cron is the worker." |
| A3 | WS messages use the existing protocol: **`command.partner_job`**, with the result returned as the `ack` `data` or an `error`. There is no `partner_job` or `partner_job_result` type. |
| A4 | `serving` means **`online`** (WS connected) in v1. Both fields stay in responses and carry the same value. |
| A5 | The pair route is **`POST /api/v1/nodes/partner-link` on Central** (node JWT). The api's existing user-JWT `POST /api/v1/nodes/link` is untouched. |
| A6 | Fix the self-asserted `POST /api/v1/nodes/:nodeId/link-retrodeck` in the same release (section D). |
| A7 | **No public-contribution plan gate. Free can publish.** Every plan has `canContributePublic: true`. The revenue lever is the plan **chunk limit** (`plans.max_chunks`). |
| A8 | **Partner docs count against the plan chunk limit**, like any other public content. |
| A9 | A provisioned account gets a **random, never-shown password**, and the platform sends a **"set your password" email** using the existing forgot/reset-password token flow. |
| A10 | The earnings source of truth is **Central `tips`**, filtered by `provider_node_id` (lineage shares are attributed correctly). |
| A11 | Schema changes: Central uses **TypeORM migrations** (next is `029`). `apps/api` uses **entities** (it runs `synchronize: true`). ParlayLedger uses **hand-applied SQL scripts** in `scripts/` (SPEC 03). |

## B. Defaults chosen for SPEC 01/02 gaps (no decision needed, override if wrong)

- **IDs:** prefixed ULIDs (`lnk_`, `job_`, `evt_`) are `text` primary keys. Add the `ulid` npm package to each app that mints them. Existing tables keep uuid.
- **Partner token:** issued and verified only by `apps/api`, signed with `PARTNER_TOKEN_SIGNING_KEY` (HS256, `aud: 'rdk-partner'`, `typ: 'partner'`). It never touches Central, so Central's node `JwtStrategy` can never accept it.
- **Consent page** at `connect.retrodeck.ai/:partnerId/:linkId`. It is served by `apps/api` as server-rendered HTML (route excluded from the `api/v1` global prefix, with a CSP override like `checkout.controller.ts`). It does **not** rely on the dashboard session cookie. The form posts email and password to the same path. The api verifies them with bcrypt, and a signed hidden form token protects against CSRF. It includes a "Forgot password?" link to the existing reset flow. nginx gets a `connect.retrodeck.ai` server block proxying to `retrodeck-api`. DNS and TLS are a manual ops step for Kevan.
- **Billing:** `POST /links/:id/billing/checkout` reuses `PlansService.selectPlan` with the partner's `successUrl`/`cancelUrl` and Stripe metadata `{ partner, linkId }`. There is no Stripe Billing Portal, so `/billing/portal` returns `{ portalUrl: 'https://dashboard.retrodeck.ai/dashboard/billing' }`. `plan.changed` is emitted wherever `users.plan_id` actually changes (checkout verify and the reconciliation cron), for users with an active partner link.
- **Plan limit errors:**
  - At enqueue, `publish_doc` runs a best-effort pre-check (`chunksUsed >= chunkLimit`), returning **`402 plan_limit_reached`** with `{ chunksUsed, chunkLimit }`.
  - If Central later rejects the sync for the limit, the node replies with error code **`plan_limit_reached`**, and the job fails with that code.
  - `402 plan_required` no longer exists.
- **Link and plan read models** add `chunksUsed` and `chunkLimit` next to `canContributePublic` (always `true`). This applies to `GET /links/:id`, `GET /partners/plans` (adds `maxChunks`) and the `plan.changed` webhook data.
- **Pair-code ownership:** codes are minted in api, which owns links and accounts. Storage is in Central's `node_pair_codes` (created through an internal call carrying `linkId`, `partnerId` and `accountId`), because redemption is authenticated by the node JWT on Central.
- **Binding on redeem:** Central sets `nodes.retrodeck_user_id = accountId` and `retrodeck_verified = true`, upserts `node_partner_permissions`, and notifies api. api then upserts the user-side `rdk_nodes` row idempotently and emits `node.paired`.
- **Events from Central to api:** `POST {api}/api/v1/internal/partners/events { type, data }` with `X-Internal-Secret`. api turns each one into a `partner_webhook_deliveries` row. Event types: `node.paired`, `node.status`, `job.completed`, `job.failed`, `job.expired`. Central stores `partner_id` and `link_id` on its partner rows so every event carries `linkId`.
- **Attestations:** api receives the `PUT`, verifies the Ed25519 signature with `partner_clients.attest_public_key`, checks staleness and `publisher:<linkId>` ownership, then forwards the verified record to Central `PUT /api/v1/internal/partners/attestations/:partnerId/:key`. Central stores `partner_attestations` and applies the quality events.
- **Migration 029 also widens `chunks.quality_score` from `DECIMAL(4,2)` to `NUMERIC(5,2)`.** This fixes the latent overflow at 100.
- **Earnings:** Central computes them. It joins `tips` to `chunks` on `chunk_id`, filters `tips.provider_node_id = <linked node>` and `chunks.external_partner = <partner>`, and groups by `chunks.external_ref`.
- **Wallet (D11 unchanged in spirit):** `rdk wallet <address>` now also calls a new Central route `PATCH /api/v1/nodes/me/wallet` (node JWT), best effort, so Central's `nodes.wallet_address` is current. Only the node can call it. The partner `GET /links/:id/node` reads `walletAddress` from there.
- **Partner query node:** the ParlayLedger query node is an ordinary RDK node (Builder plan) calling `/api/v1/query` with its own node JWT. The new filters are public reads.

## C. Wire contracts (replace the SPEC 01 Phase 3-5 and SPEC 02 Phase 2-4 shapes)

### C1. Pairing (node to Central)
`POST {central}/api/v1/nodes/partner-link`, `Authorization: Bearer <node JWT>`, body `{ pairCode }`. The code is normalized (uppercase, spaces and dashes removed), then SHA-256 hashed.

`200` response:
```json
{ "partnerId": "parlayledger", "partnerName": "ParlayLedger", "linkId": "lnk_...", "accountId": "<uuid>", "allowedJobTypes": ["publish_doc","unpublish_doc","ping"] }
```

Errors use the body shape `{ code, message }`:

| Status | Code |
|---|---|
| 404 | `pair_code_invalid` |
| 410 | `pair_code_expired` |
| 409 | `pair_code_used` |
| 409 | `node_owned_by_other_account` |

The `node_owned_by_other_account` message is the SPEC 01 wording verbatim, with `rdk init --link` in it. That error fires when `retrodeck_user_id` is already set to a different account and is verified. A node with `retrodeck_user_id` null, or set but unverified, is attached to the link's account.

The CLI stores `accountId` as `retrodeckUserId` in config.

**Amendment (2026-10-11, after the CLI build):** `rdk init --link` registers a fresh node with a placeholder owner email `node-<rand>@pairing.invalid` (Central's register requires an email). On a successful redemption, if the node's `owner_email` ends with `@pairing.invalid`, Central replaces it with the linked account's email. api passes that email to Central when it mints the code (`node_pair_codes.account_email`).

### C2. Job delivery (Central to node)
Central sends:
```json
{ "type": "command.partner_job", "id": "<cmd id>", "data": { "jobId": "job_...", "partnerId": "parlayledger", "jobType": "publish_doc", "payload": { }, "issuedAt": "..." } }
```

On success the node replies `{ "type": "ack", "replyTo": "<cmd id>", "data": <result> }`. The result shapes are SPEC 02 Phase 2:
- `publish_doc`: `{ ref, contentHash, chunkHashes, chunkIds, indexedAt }`, where `chunkIds` equals `chunkHashes`, because the node only knows hashes. Central may substitute its own uuids before emitting `job.completed`.
- `unpublish_doc`: `{ ref, removedChunkHashes }` or `{ ref, alreadyRemoved: true }`.
- `ping`: `{ cliVersion, serving, publicChunks, partnerDocs }`.

On failure the node replies `{ "type": "error", "replyTo": "<cmd id>", "error": { "code": "<code>", "message": "..." } }`. The node client must pass a thrown error's `.code` through. Today it hard-codes `COMMAND_FAILED`; keep that only as the fallback.

Node error codes:
- **Terminal:** `partner_not_linked`, `partner_disabled`, `job_type_not_allowed`, `invalid_payload`, `content_hash_mismatch`, `doc_too_large`, `invalid_filename`, `pinning_unavailable`, `plan_limit_reached`.
- **Transient:** `rate_limited` (index rate limit), `node_busy`.

Central delivery rules:
- **When:** on the first session connect for a node, and on a 30 s cron for every online node with queued jobs.
- **Selection:** `status = 'queued' AND expires_at > now()`, oldest first, up to 20. Sent **sequentially** per node, never in parallel.
- **Command timeout:** 120 s (not the 10 s default).
- **State:** `queued`, then `delivered` (in flight, `attempts++`), then one of:
  - ack: `completed`
  - terminal error: `failed`
  - transient error, timeout or disconnect: back to `queued`
- `attempts > 5` without a terminal outcome: `failed` with `{ code: 'no_result' }`.
- **Amendment (2026-10-11):** a `rate_limited` reply returns the job to `queued` **without** counting toward that limit (the increment is undone). `node_busy`, timeouts and disconnects still count. The 7-day expiry is the backstop.
- The CLI forwards node error codes exactly as listed above. Unexpected node failures arrive as `node_busy`; too-short or near-duplicate documents arrive as `invalid_payload`.
- An old node that answers `Unknown command`: `failed` with `{ code: 'node_outdated', message: 'Update RDK: npm install -g @retrodeck/rdk' }`.
- A `delivered` job older than 10 minutes (Central restart mid-flight) is reset to `queued` by the cron.

### C3. Chunk sync
Each chunk in `POST /api/v1/chunks/sync` and `/sync/batch` gains optional `externalPartner?: string` and `externalRef?: string`. Central stores them only when the syncing node has an enabled `node_partner_permissions` row for that partner. Otherwise it drops them and logs a warning. The CLI sends them from all three payload builders.

### C4. Network query
`NetworkQueryDto` gains `filters?: { externalPartner?: string; attestedStatus?: string[]; categories?: string[] }`. `categories` is ALL-match: `categories @> $n::text[]`. Each result gains:
- `externalRef: { partner, ref } | null`
- `attestation: { kind, status, record, signedAt } | null`
- `publisherRecord: <record> | null`, which comes from `publisher:<linkId>` via the chunk's node to `node_partner_permissions.link_id`.

### C5. Local query API (`rdk api:serve`)
As SPEC 02 Phase 4, built on the existing two-phase flow:
1. Phase 1 is `previewOnly` with `filters`.
2. Then results are walked in score order. Before each phase-2 select, add its preview `tipUsdc` to the running total. Stop once the next one would exceed `maxTipUsdc`. The rest return `content: null, skippedReason: 'tip_cap'`.

Tips are settled by Central from the node's RetroDeck credits (`settledByCentral`), not by x402. `api:serve` does not open the WS session.

### C6. Wallet
`PATCH {central}/api/v1/nodes/me/wallet` (node JWT) `{ walletAddress, walletChain }` returns 204. The address is validated as `0x` plus 40 hex characters.

## D. `link-retrodeck` fix (A6)
`POST /api/v1/nodes/:nodeId/link-retrodeck` now requires:
- `:nodeId === req.user.id` (JWT `sub`), else `403`.
- A body field `retrodeckAccessToken`. Central verifies it through a new api route, `POST {api}/api/v1/internal/auth/introspect { token }`, which returns `{ userId } | 401`. The returned `userId` must equal `retrodeckUserId`. Without valid proof the response is `403 { code: 'link_proof_required' }`, and nothing is written.
- The CLI (`init`, `account:relink`, `link-node.ts`) sends its `retrodeckAccessToken`. A failure stays non-fatal in `init`, as it is today.

## E. Ownership split (where each SPEC 01 table lives)

| Table | App |
|---|---|
| `partner_clients`, `partner_links`, `users.partner_source`, `partner_webhook_deliveries` | api (entities) |
| `node_pair_codes`, `node_partner_permissions`, `partner_jobs`, `partner_attestations`, `chunks.external_partner`/`external_ref`, last-applied quality status per chunk | Central (migration 029) |
