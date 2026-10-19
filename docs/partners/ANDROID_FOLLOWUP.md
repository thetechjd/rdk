# Android node: ParlayLedger partner support (follow-up ticket)

**Repo:** `Ascendant-Finance/rdk-mobile-node` (React Native 0.87 + embedded Node, `applicationId` `com.retrodeck.android`)
**Contract:** `docs/partners/RDK_PL_00A_AMENDMENTS.md` (C1, C2, C3, C6, D) and `RDK_PL_02_RDK_CLI.md` in this repo
**Reference implementation:** branch `feat/rdk-partner-link`, in `packages/rdk-node` and `packages/rdk-core`
**Estimate:** about 2 to 3 dev days, plus on-device QA

## Why

ParlayLedger users pair a node with a one-time code and then publish picks to it. The app can't do either today:
- **No pairing UI.** It has no pair-code screen.
- **Old protocol code.** It ships a vendored snapshot of `@rdk/node` and `@rdk/core` (`app/src/main/assets/node/node_modules/@rdk/*` and the duplicates under `assets/node/rdk/*`) that predates the partner work.
- **Jobs fail.** The ParlayLedger dashboard shows Android as "coming soon" until this ships. Any partner job sent to the app fails with `node_outdated`.

## Work

### 0. Re-vendor the shared packages (prerequisite)

1. Build `@rdk/core` and `@rdk/node` from `feat/rdk-partner-link` once it is merged.
2. Replace both vendored copies with the build.
3. Add a small script that does this, so future re-syncs aren't manual.

What the re-vendor brings with it:
- **Job handler:** the `command.partner_job` handler (`ws/handlers/partner-job`).
- **Error codes:** the WS client forwards error codes; the old copy hard-codes `COMMAND_FAILED`.
- **External refs:** the sync payload carries `externalRef`.
- **Delete path:** `LocalStore.deleteDocument`.
- **Linking proof:** `ensureNodeLinked` now sends `retrodeckAccessToken` to Central's `link-retrodeck`. The app already stores `retrodeckUserId`.

### 1. Wire the handler to the app's store

`partner-job` opens `new LocalStore()` by default, which resolves to `files/.rdk-node/index.db`, not the app's store at `files/.rdk`. Two changes are needed:
- Register the handler with the app's store: `createPartnerJobHandler({ ...defaultPartnerJobDeps, openStore: () => store })`.
- Call `setHostVersion('android-<versionName>')` at startup. Without it, `ping` returns a null version.

### 2. Pair screen

- **`src/App.tsx`:**
  - Add a `Page` value.
  - Add a More menu row labeled `Link to ParlayLedger`.
  - Add a screen with an 8-character code input. Accept `XXXX-XXXX` or `XXXXXXXX`, case-insensitive.
- **`src/rdk-api.ts`:** add `linkPartner(code)`.
- **`mobile-server.js`:** add `POST /partners/link`. It ensures the node is registered and connected, then calls `redeemPairCode` and `savePartnerLink` (from `partner-link`).
- **Copy:** reuse the CLI's messages exactly:
  - Success: `Linked to ParlayLedger.`
  - Invalid code: `That code is not valid. Get a new one from your ParlayLedger dashboard.`
  - Expired code: `That code expired. Get a new one from your ParlayLedger dashboard.`
  - Used code: `That code was already used. Get a new one from your ParlayLedger dashboard.`
  - Owned by another account: show the platform message verbatim.

### 3. Staying online

The manifest has no foreground service, so the node is online only while the app process lives. Queued jobs wait until it reconnects and expire after 7 days. Decide whether to add a foreground service with a persistent notification, and record the decision.

### 4. Wallet

The app has no wallet UI; registration hard-codes `walletChain: 'base'`. To receive earnings, add a payout address field that writes local config and calls `PATCH /api/v1/nodes/me/wallet` (00A C6).

## Acceptance

1. Pairing with valid, invalid, expired and used codes shows the right messages, and `GET /partners/links/:id/node` reports the device online.
2. A `publish_doc` job from ParlayLedger writes `files/.rdk/partners/parlayledger/<ref>.md`, indexes it as public with `externalRef`, and the job completes. A replay is idempotent.
3. `unpublish_doc` removes the chunks, the documents row and the file.
4. `ping` returns `cliVersion` starting with `android-`.
5. Linking an account sets `retrodeck_user_id` on Central (via `link-retrodeck` with proof).

## When done

Flip `RDK_ANDROID_AVAILABLE` to `true` in the ParlayLedger dashboard once the app is listed at https://play.google.com/store/apps/details?id=com.retrodeck.android.
