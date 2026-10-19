# RDK x ParlayLedger: RDK Platform Partner Module (SPEC 01)

**Repo:** retrodeck-docker, `apps/api` + `apps/central-api`.
**Depends on:** SPEC 00 and **RDK_PL_00A_AMENDMENTS.md (wins on conflict; see its section E for which app owns which table)**.
**Delivers:** partner clients, account linking with consent, pair codes, node job relay, attestations, partner read endpoints, query filters, webhooks.
Phase 0 is done: `docs/partners/PHASE0_REPORT.md`.

---

## Phase 1: Data model
Column naming per repo convention (snake_case columns). Table placement per 00A section E.

```sql
CREATE TABLE partner_clients (
  id text PRIMARY KEY,                 -- 'parlayledger'
  display_name text NOT NULL,          -- 'ParlayLedger'
  client_id text UNIQUE NOT NULL,
  client_secret_hash text NOT NULL,    -- argon2id (bcrypt acceptable if argon2 is unavailable; note in the commit)
  attest_public_key text,              -- ed25519, base64
  webhook_url text NOT NULL,
  webhook_secret_enc text NOT NULL,    -- AES-256-GCM with PARTNER_SECRETS_KEY
  allowed_return_urls text[] NOT NULL,
  scopes text[] NOT NULL,              -- partner-level: attest:write, query:filter
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE partner_links (
  id text PRIMARY KEY,                 -- lnk_ULID
  partner_id text NOT NULL REFERENCES partner_clients(id),
  external_user_id text NOT NULL,
  account_id uuid REFERENCES users(id),
  status text NOT NULL,                -- pending_consent | active | revoked
  scopes text[] NOT NULL,
  provisioned boolean NOT NULL DEFAULT false,
  code_challenge text,                 -- PKCE S256, cleared on completion
  auth_code_hash text,                 -- single use
  auth_code_expires_at timestamptz,
  return_url text,
  revoked_at timestamptz, revoked_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- unique (partner_id, external_user_id) WHERE status <> 'revoked'

users.partner_source text   -- 'parlayledger' when provisioned by a partner

CREATE TABLE node_pair_codes (
  code_hash text PRIMARY KEY,          -- sha256 of normalized code
  link_id text NOT NULL, partner_id text NOT NULL, account_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  redeemed_node_id uuid
);

CREATE TABLE node_partner_permissions (
  node_id uuid NOT NULL,
  partner_id text NOT NULL,
  link_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  allowed_job_types text[] NOT NULL DEFAULT '{publish_doc,unpublish_doc,ping}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, partner_id)
);

CREATE TABLE partner_jobs (
  id text PRIMARY KEY,                 -- job_ULID
  link_id text NOT NULL, partner_id text NOT NULL,
  node_id uuid,                        -- the link's paired node at enqueue
  type text NOT NULL,                  -- publish_doc | unpublish_doc | ping
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL,                -- queued | delivered | completed | failed | expired
  attempts int NOT NULL DEFAULT 0,
  result jsonb, error jsonb,
  expires_at timestamptz NOT NULL,
  delivered_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (link_id, type, idempotency_key)
);
CREATE INDEX ON partner_jobs (node_id, status);

ALTER TABLE chunks ADD COLUMN external_partner text;
ALTER TABLE chunks ADD COLUMN external_ref text;
CREATE INDEX ON chunks (external_partner, external_ref);
-- plus a column for the last applied attestation status per chunk (idempotent quality events)
-- plus: ALTER chunks.quality_score TYPE NUMERIC(5,2)   (00A section B)

CREATE TABLE partner_attestations (
  partner_id text NOT NULL,
  key text NOT NULL,                   -- pub_... or publisher:lnk_...
  kind text NOT NULL,
  record jsonb NOT NULL,
  status text NOT NULL,
  data_version timestamptz NOT NULL,
  signed_at timestamptz NOT NULL,
  signature text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, key)
);

CREATE TABLE partner_webhook_deliveries (
  id text PRIMARY KEY,                 -- evt_ULID, sent as body.id
  partner_id text NOT NULL,
  type text NOT NULL,
  body jsonb NOT NULL,
  status text NOT NULL,                -- pending | delivered | failed
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Seed script `scripts/seed-partner-parlayledger.ts`: creates the `parlayledger` row from env (`PL_CLIENT_ID`, `PL_CLIENT_SECRET`, `PL_ATTEST_PUBLIC_KEY`, `PL_WEBHOOK_URL`, `PL_WEBHOOK_SECRET`, `PL_RETURN_URLS`), prints nothing secret. Idempotent (upsert).

---

## Phase 2: Partner auth and linking (apps/api)

### Partner token
`POST /api/v1/partners/token` body `{ grant_type: 'client_credentials', client_id, client_secret }` → `{ access_token, token_type: 'Bearer', expires_in: 900 }`. JWT claims `{ sub: partnerId, typ: 'partner', scopes }` (signing per 00A B). `PartnerAuthGuard` on every `/api/v1/partners/*` route below. Rate limit 600 req/min per partner.

### Start link
`POST /api/v1/partners/links`
```json
{ "externalUserId": "pl_user_123", "email": "a@b.com", "emailVerified": true,
  "displayName": "handle", "codeChallenge": "<S256>", "returnUrl": "https://.../v1/rdk/connect/callback",
  "mode": "auto" }
```
- `emailVerified` must be `true`, else `422 email_not_verified`.
- `returnUrl` must be in `allowed_return_urls`, else `422 invalid_return_url`.
- Existing non-revoked link for `(partner, externalUserId)`: return it (200) with its current status.
- `mode: 'auto'` and no user with that email: create user (plan free, `partner_source='parlayledger'`, `email_verified=true`, random never-shown password, unique display name derived from `displayName`, plus every side effect the normal register path performs: balance row, referral code, drip enrolment, Koryo capture with source parlayledger), send the set-password email (00A A9), create link `active` with all v1 user scopes, emit `link.activated`. Return `201 { linkId, status: 'active', accountId, created: true, plan }`.
- User exists for that email, or `mode: 'existing'`: create link `pending_consent`, store `code_challenge`, return `200 { linkId, status: 'pending_consent', consentUrl: '<CONNECT_BASE_URL>/parlayledger/<linkId>', expiresAt: now+30min }`.

### Consent page (`connect.retrodeck.ai/:partnerId/:linkId`, per 00A B)
One screen: RetroDeck cartridge logo, then "ParlayLedger wants to connect to your RetroDeck account." Sign-in form (email + password, "Forgot password?" link). Scope list in plain words:
- See your RDK account, plan and node status
- Publish ParlayLedger picks and strategies to your node
- See your RDK earnings from ParlayLedger publications
- Start plan upgrades for you
Buttons **Connect** and **Cancel**.
- On Connect (credentials valid): set `account_id`, mint single-use auth code (32 random bytes, store hash, 5-minute expiry), redirect to `returnUrl?link=<linkId>&code=<code>`.
- On Cancel: redirect to `returnUrl?link=<linkId>&error=access_denied`.
- If that account is already linked (active) to a different ParlayLedger user: show "This RetroDeck account is already connected to another ParlayLedger account." and no Connect button.
- Expired or non-pending link: show a plain error, no form. No em dashes in any copy.

### Complete link
`POST /api/v1/partners/links/:linkId/complete { code, codeVerifier }`: verify code hash, expiry, single use, `base64url(sha256(codeVerifier)) == code_challenge`. Set `active`, clear PKCE fields, emit `link.activated`. Return `{ status: 'active', accountId, plan, nodes: [{ nodeId, displayName, online }] }`.

### Read and revoke
- `GET /api/v1/partners/links/:linkId` → `{ linkId, status, accountId, plan, planStatus, canContributePublic, chunksUsed, chunkLimit, node: { nodeId, online, lastSeenAt, cliVersion, partnerJobsEnabled } | null }`
- `DELETE /api/v1/partners/links/:linkId` → `revoked`, `revoked_by='partner'`, disable Central `node_partner_permissions` for the link (internal call), emit `link.revoked`. 204.
- (User-side revoke from dashboard.retrodeck.ai is a follow-up, out of scope. Provide the service method with `revoked_by='user'`.)

Every `/partners/links/:linkId/*` route: link must belong to the calling partner and be `active` (except GET, which also returns pending/revoked), and the route's scope must be in `partner_links.scopes`. Errors: `404 link_not_found`, `409 link_not_active`, `403 scope_missing`. Error body `{ code, message }`.

---

## Phase 3: Pair codes and node binding
`POST /api/v1/partners/links/:linkId/pair-codes` (scope `node:jobs`): 8 Crockford base32 chars (alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`), formatted `XXXX-XXXX`, store sha256 of the normalized code, 10-minute expiry, invalidate unredeemed codes for the link. Returns `{ code, expiresAt, commands: { existing: 'rdk link K7Q2-M9XD', fresh: 'rdk init --link K7Q2-M9XD' } }`.

Redemption: Central `POST /api/v1/nodes/partner-link` per 00A C1.
- One paired node per link in v1. Pairing a second node disables the old permission row; queued jobs for the link are re-targeted to the new node.
- Emit `node.paired` (via 00A events).

---

## Phase 4: Job relay

### Enqueue (api, forwards to Central)
`POST /api/v1/partners/links/:linkId/jobs` (scope `node:jobs`) `{ "type": "publish_doc", "idempotencyKey": "pub_01J9...", "payload": { ... } }`
- Link must have a paired node with permissions enabled, else `409 node_not_paired`.
- `publish_doc` best-effort chunk-limit precheck → `402 plan_limit_reached` (00A B).
- Validate payload by type. Doc over 32,768 bytes → `413 doc_too_large`.
- Same `(link, type, idempotencyKey)` exists → return existing job (200). New job → 201. Returns `{ jobId, status, expiresAt }`, `expiresAt = now + 7 days`.

```ts
type PublishDocPayload = {
  ref: string;            // pub_ULID
  filename: string;       // `${ref}.md`, /^pub_[0-9A-HJKMNP-TV-Z]{26}\.md$/
  markdown: string;
  contentHash: string;    // 'sha256:<hex>' of markdown UTF-8 bytes
  categories: string[];
  domain: 'sports-betting';
  visibility: 'public';
  pin: boolean;           // must be false unless RDK_PINNING_ENABLED
};
type UnpublishDocPayload = { ref: string };
type PingPayload = {};
```

### Deliver (Central): per 00A C2. Expiry cron every 15 min: queued/delivered past `expires_at` → `expired`, emit `job.expired`. Node connect/disconnect for a node with partner permissions emits `node.status`, debounced to at most one per node per 60 s.

### Read
- `GET /api/v1/partners/jobs/:jobId` → full job minus payload markdown.
- `GET /api/v1/partners/links/:linkId/jobs?status=&limit=` → list.

### Chunk sync carries the external ref: per 00A C3. `DELETE /api/v1/chunks/:chunkHash` unchanged.

---

## Phase 5: Attestations, query filters, quality

### Write attestation
`PUT /api/v1/partners/attestations/:key` (partner scope `attest:write`), body per SPEC 00 section 11. Verify Ed25519 over canonical JSON (sorted keys, no whitespace, `signature` omitted) → `401 bad_signature`. Reject `signedAt` older than stored → `409 stale_attestation`. `publisher:<linkId>` requires the link to belong to this partner. Upsert, then run quality events for every chunk with `(external_partner, external_ref) = (partner, key)`. 204. (Split between api and Central per 00A B.)

### Query filters and enrichment: per 00A C4. Both filters are public reads. Offline-node behavior unchanged.

### Quality events
| Event | Delta | When |
|---|---|---|
| `attested_verified_winning` | +5.0 once | status becomes `verified_winning` |
| `attested_lost_verification` | -5.0 once | status leaves `verified_winning` |
| `attested_graded_loss` | -1.0 | a pick attestation's `pick.result` becomes `loss` |
| `attested_graded_win` | +1.0 | a pick attestation's `pick.result` becomes `win` |
Store the last applied status (and pick result) per chunk so events are idempotent. Clamp score to [0, 100].

---

## Phase 6: Partner read endpoints

`GET /api/v1/partners/links/:linkId/node` (scope `node:read`)
```json
{ "nodeId": "...", "displayName": "...", "online": true, "serving": true, "lastSeenAt": "...",
  "cliVersion": "1.15.0", "walletAddress": "0x...", "publicChunks": 412, "partnerDocs": 37, "pendingJobs": 2 }
```
`cliVersion` may be null when unknown (Central does not record it today; populate from the most recent `ping` job result if one exists).

`GET /api/v1/partners/links/:linkId/earnings?from=&to=` (scope `earnings:read`), computed per 00A B:
```json
{ "currency": "USDC",
  "totals": { "allTime": 12.84, "partnerDocsAllTime": 9.10, "pending": 0.42, "settled": 12.42 },
  "byRef": [ { "ref": "pub_...", "retrievals": 31, "earned": 1.86, "lastRetrievedAt": "..." } ],
  "history": [ { "at": "...", "ref": "pub_...", "amount": 0.06, "status": "settled", "txHash": "..." } ] }
```
`history` max 200 rows newest first, partner docs only.

`POST /api/v1/partners/links/:linkId/billing/checkout` (scope `billing:manage`) `{ planId, interval: 'monthly' | 'yearly', successUrl, cancelUrl }`. URLs must share an origin with an allowed return URL. Returns `{ checkoutUrl }`.
`POST /api/v1/partners/links/:linkId/billing/portal` → `{ portalUrl }` (00A B).
`GET /api/v1/partners/plans` → `[{ planId, name, priceMonthly, priceYearly, canContributePublic, maxChunks, highlights[] }]`.
Emit `plan.changed` on any plan change for a user with an active partner link.

---

## Phase 7: Webhook sender (api)
`PartnerWebhookService.emit(partnerId, type, data)` inserts into `partner_webhook_deliveries`; a cron sweep (every 15-30 s) posts due rows to `webhook_url` with the SPEC 00 section 10 signature header. 2xx = delivered. Retry schedule: 30 s, 2 min, 10 min, 1 h, 6 h, then `failed`. Internal endpoint `POST /api/v1/internal/partners/webhooks/:id/redeliver` (X-Internal-Secret).

---

## Phase 8: Tests and acceptance
Use the repo's existing test framework(s).
1. New email via `/partners/links` creates a user with `partner_source='parlayledger'` and an `active` link, and sends the set-password email.
2. Existing email returns `pending_consent`. Completing with a wrong verifier fails. Completing twice fails.
3. Pair code: expired, reused, wrong account, and fresh-node cases each return the specified error.
4. `publish_doc` over the chunk limit returns `402 plan_limit_reached`. A Free plan under its limit succeeds.
5. A job queued while the node is offline is delivered on connect and completes once, even if the node reconnects twice. Transient errors requeue; an `Unknown command` reply fails with `node_outdated`.
6. Chunk sync with `externalRef` from a node without permission stores no external ref.
7. Attestation with a bad signature is rejected. A stale `signedAt` is rejected.
8. `/query` with `filters.externalPartner='parlayledger'` returns only matching chunks, each with `attestation`.
9. Revoking a link blocks job enqueue with `409 link_not_active` and emits `link.revoked`.
10. Webhook signature verifies with a test secret. Delivery retries on 500.
11. `link-retrodeck` without valid proof returns `403 link_proof_required` and writes nothing (00A D).
12. `quality_score` can reach 100.00 without overflow.
Plus the SPEC 00 section 15 greps on changed paths.

**Env added:** `PARTNER_SECRETS_KEY`, `PARTNER_TOKEN_SIGNING_KEY`, `CONNECT_BASE_URL=https://connect.retrodeck.ai`, `RDK_PINNING_ENABLED=false`, seed vars above. Add them to `.env.example` files and compose (without values).

**Do not:** expose content through any partner endpoint, accept job types outside the allowlist, let a partner set a node's wallet, push, or deploy without Kevan's sign-off.
