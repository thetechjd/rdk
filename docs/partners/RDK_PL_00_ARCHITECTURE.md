# RDK x ParlayLedger Integration: Architecture and Contracts (SPEC 00)

**Owner:** Kevan Williams / Ascendant Finance LLC
**Status:** Build spec v1. **Amended by RDK_PL_00A_AMENDMENTS.md, which wins on any conflict.**

| Spec | Repo / app |
|---|---|
| 00 | Contracts only |
| 01 | RDK platform (`apps/central-api` + `apps/api` in retrodeck-docker) |
| 02 | RDK CLI node (`packages/rdk-cli`, shared code in `packages/rdk-node`) |
| 03 | ParlayLedger API (NestJS) |
| 04 | ParlayLedger dashboard + docs page |

## 1. What we are building
RDK becomes a first-party plug-in inside ParlayLedger. A PL user can: activate RDK (new RetroDeck account created or existing one connected); pair their node with one command; publish picks and strategies from the PL dashboard (written to the user's own node as public RDK documents; user earns USDC tips on retrieval); get verified (PL grades picks and backtests strategies, attaches signed records to chunks; verified winners rank higher); ask the network and backtest results; run everything from ParlayLedger (never opens dashboard.retrodeck.ai).

## 2. Ground rules
- Users control their own node and data. Neither RDK nor PL hosts a node for a user.
- No cloud-only publishing. A publication is retrievable only once indexed on the user's own node. Publications queue until the node is online.
- Central routes, nodes store. Central holds embeddings/metadata; content fetched live from the owning node over WS. Pinning is the only exception (explicit, paid).
- Offline means skipped.
- Branding: RetroDeck NES cartridge logo + RETRODECK wordmark. The orange rounded-square "RDK" badge must never appear.

## 3. Actors
PL user; RDK account (linked 1:1 to PL user); user node (`rdk` CLI or desktop app on user's device); PL query node (headless RDK node run by ParlayLedger as a Builder, pays tips from PL's account under a per-query cap); RDK platform (Central + RetroDeck API, gains a Partner module); PL API (gains `rdk` module); PL dashboard.

## 4. Locked decisions
**D1.** Partner credentials are server-to-server only. Partner `parlayledger` with `client_id`/`client_secret`; secret only in PL API env.
**D2.** Activation: PL calls `POST /api/v1/partners/links` with PL user id and **verified** email. No RetroDeck account with that email → provision one (`partner_source='parlayledger'`), link `active`. Existing account, or user chooses "I already have a RetroDeck account" → `pending_consent` + `consentUrl`; user signs in and approves on a single consent screen (popup) at `connect.retrodeck.ai`. Email match alone never links an existing account. OAuth 2.0 authorization code with PKCE (S256); PL generates the verifier, sends the challenge at link start, exchanges code + verifier server-side.
**D3.** PL authenticates as the partner (client credentials, 15-minute token) and names the user by `linkId` in the path. Platform checks link `active` and scope granted. No per-user tokens. Revoking from either side cuts access immediately. User scopes (v1): `account:read`, `node:read`, `node:jobs`, `earnings:read`, `billing:manage`. Partner-level scopes: `attest:write`, `query:filter`.
**D4.** Pair codes: 8 chars Crockford base32, displayed `XXXX-XXXX`, single use, 10-minute TTL. Commands `rdk link K7Q2-M9XD` / `rdk init --link K7Q2-M9XD`. Redeeming binds node to the linked RDK account and enables partner jobs for `parlayledger` on that node.
**D5.** Commands reach the node through a Central job relay over the node's existing WebSocket (see 00A C2 for wire shape), flushed on reconnect. Central notifies PL by signed webhook. Jobs expire after 7 days. Job types v1 (node rejects anything else): `publish_doc`, `unpublish_doc`, `ping`.
**D6.** Queries run on the PL query node (embeds, calls Central `/query`, fetches content, pays tips under a per-query cap). Querying still requires RDK activation.
**D7.** ~~Publishing requires a plan that can contribute publicly~~ **Amended (00A A7/A8):** publishing requires a paired node; every plan can contribute; partner docs count against the plan chunk limit; over-limit returns `402 plan_limit_reached`.
**D8.** ParlayLedger is the sole grader of PL publications. Publications immutable; timestamp is PL server time at submit; odds captured by PL; unpublishing removes the chunk from the network but never the pick from the record. SafeParlay grading is never used.
**D9.** Verification travels as attestations. PL writes signed attestations with `attest:write`, keyed by `(partner, ref)`. Central applies them to every chunk whose `external_ref` matches, returns them with query results, and feeds them into quality scoring. Nodes cannot write attestations.
**D10.** Strategies are structured (Rule DSL v1); backtests deterministic, pregame-only, cached by `(rules_hash, data_version)`.
**D11.** Payout address is set on the node only (`rdk wallet <address>`). PL shows it read-only. A partner must never be able to redirect a user's earnings.
**D12.** Content boundary: PL stores structured publications; node stores the retrievable document; Central stores embeddings, metadata, attestations. PL never reads a user's private vault. No v1 job type can read node content.

## 5. Identifiers
| Name | Format | Issued by |
|---|---|---|
| `partnerId` | slug, `parlayledger` | Platform (seeded) |
| `linkId` | `lnk_` + ULID | Platform |
| `accountId` | existing RetroDeck user id (uuid) | Platform |
| `nodeId` | existing uuid | Platform |
| `pairCode` | `XXXX-XXXX` Crockford base32 | Platform |
| `jobId` | `job_` + ULID | Platform |
| `ref` / `publicationId` | `pub_` + ULID | PL API |
| `externalRef` on a chunk | `{ partner: 'parlayledger', ref: 'pub_...' }` | Node, from job payload |
| Publisher attestation key | `publisher:<linkId>` | PL API |

## 6. Flows
**6.1 Activate (new account):** PL `POST /partners/links { externalUserId, email, emailVerified: true, displayName, codeChallenge, returnUrl }` → platform provisions (Free, `partner_source='parlayledger'`) → `201 { linkId, status: 'active', accountId, created: true }`.
**6.2 Activate (existing):** → `200 { linkId, status: 'pending_consent', consentUrl, expiresAt }`; popup; user signs in and approves; redirect `returnUrl?link=<linkId>&code=<code>`; PL calls `POST /partners/links/:linkId/complete { code, codeVerifier }` → `{ status: 'active', accountId, plan, nodes[] }`.
**6.3 Pair:** PL `POST /partners/links/:linkId/pair-codes`; user runs `rdk link CODE`; CLI calls Central (00A C1); platform binds, enables partner jobs, sends `node.paired`; CLI writes `partners.parlayledger` into `~/.rdk/config.json`.
**6.4 Publish:** PL creates immutable publication, renders doc (section 7), computes `contentHash`, calls `POST /partners/links/:linkId/jobs { type: 'publish_doc', idempotencyKey: ref, payload }`. Platform checks scope and plan limit, stores the job, delivers over WS. Node writes the doc to its managed partner folder, indexes as public with `externalRef`, syncs, replies with chunk ids. Platform marks completed, sends `job.completed`. Node offline: job stays queued.
**6.5 Grade and attest:** PL `PUT /partners/attestations/:key`; Central attaches to matching chunks and applies quality events.
**6.6 Query:** PL query node runs network query with `filters.externalPartner='parlayledger'` and a tip cap.
**6.7 Upgrade:** PL → `POST /partners/links/:linkId/billing/checkout` → `{ checkoutUrl }`; platform sends `plan.changed`.
**6.8 Unlink:** either side revokes; `DELETE /partners/links/:linkId`; platform sends `link.revoked`. User keeps account, node, documents. Attestations stay.

## 7. Document format written to the node
One markdown file per publication at `~/.rdk/partners/parlayledger/<ref>.md`. PL renders it; the node writes it byte-for-byte and verifies `contentHash` (SHA-256 of the UTF-8 bytes, `sha256:<hex>`). Front matter starts with `rdk_partner: parlayledger`, `ref: pub_...`, `type: pick|strategy`. Categories sent with the job: `['parlayledger', 'sports', '<sport>', '<league>', '<type>']`. Domain: `sports-betting`.

## 9. Constants (platform-relevant)
| Constant | Value |
|---|---|
| `DOC_MAX_BYTES` | 32768 (Central and node enforce) |
| `JOB_TTL_DAYS` | 7 |
| `PAIR_CODE_TTL_MINUTES` | 10 |
| `QUERY_TIP_CAP_USDC` | 0.25 |
| `QUERY_TOPK` | 8 |

## 10. Webhooks (platform → PL)
`POST {PL_API}/v1/rdk/webhooks`, JSON body `{ id, type, createdAt, data }`.
Header `X-RDK-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the partner webhook secret>`. PL rejects if timestamp > 300 s old or signature fails; dedupes on `id`.

| Type | `data` |
|---|---|
| `link.activated` | `{ linkId, accountId, plan }` |
| `link.revoked` | `{ linkId, revokedBy: 'user' \| 'partner' \| 'platform' }` |
| `node.paired` | `{ linkId, nodeId }` |
| `node.status` | `{ linkId, nodeId, online, lastSeenAt }` (connect and disconnect) |
| `plan.changed` | `{ linkId, plan, planStatus, canContributePublic, chunksUsed, chunkLimit }` |
| `job.completed` | `{ linkId, jobId, type, idempotencyKey, result }` |
| `job.failed` | `{ linkId, jobId, type, idempotencyKey, error: { code, message } }` |
| `job.expired` | `{ linkId, jobId, type, idempotencyKey }` |

## 11. Attestation format
`PUT /api/v1/partners/attestations/:key` where `key` is a `pub_` ref or `publisher:<linkId>`.
```json
{
  "kind": "pick" | "strategy" | "publisher",
  "subject": { "ref": "pub_..." } | { "linkId": "lnk_..." },
  "record": {
    "sample": 41, "wins": 24, "losses": 16, "pushes": 1,
    "units": 6.3, "roi": 0.11,
    "status": "pending" | "graded" | "verified_winning" | "unverified",
    "pick": { "result": "win" | "loss" | "push" | "void" | "pending", "unitsDelta": 1.36 },
    "forward": { "sample": 12, "units": 2.4 },
    "backtest": { "sample": 64, "units": 10.9, "dataVersion": "..." }
  },
  "dataVersion": "2026-10-11T06:00:00Z",
  "signedAt": "2026-10-11T23:58:00Z",
  "signature": "ed25519:<base64>"
}
```
PL signs the canonical JSON (keys sorted recursively, no whitespace) of everything except `signature` with Ed25519. The platform verifies with the registered partner public key. Fields that do not apply to a `kind` are omitted. `pick` only for `kind: 'pick'`; `forward`/`backtest` only for `kind: 'strategy'`.

## 15. Global acceptance checks
```bash
grep -rn $'\xe2\x80\x94' <changed paths>   # no em dashes in user-facing strings/docs
grep -rniE "guaranteed|can't lose|sure thing|risk-free|\block\b" <ui + docs paths>
grep -rniE "rdk-badge|rdk_badge|orange.*badge" <changed paths>
grep -rn "RDK_PARTNER_CLIENT_SECRET" <dashboard build output>
```
