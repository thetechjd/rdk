# RDK x ParlayLedger: Contract Amendments to SPEC 03 and 04 (00B)

**Status:** Binding. Approved by Kevan on 2026-10-18 after the Phase 0 reports.
Read with `RDK_PL_00A_AMENDMENTS.md`, which already applies to the platform and CLI side and is restated here only where it changes ParlayLedger.
Where this file conflicts with SPEC 00, 03 or 04, this file wins.

## A. What changed upstream (from 00A, as already built)

- **No plan gate.** Every RDK plan can publish. `402 plan_required` does not exist.
  - The platform returns **`402 plan_limit_reached`** with `{ chunksUsed, chunkLimit }` when the account's chunk limit is full.
  - A node can also fail a job with code `plan_limit_reached`.
  - In both cases ParlayLedger shows the upgrade card (copy in section F).
- **Link and plan read models** carry `chunksUsed`, `chunkLimit` and `canContributePublic` (always `true`). `GET /partners/plans` carries `maxChunks`. The `plan.changed` webhook carries `chunksUsed` and `chunkLimit`.
- **`serving` equals `online`** in v1.
- **Webhooks are at least once and may repeat with different ids.** Every ParlayLedger webhook handler must be idempotent by effect (set state, never increment), not only by `id`.
- **New-node job failures.** A node too old for partner jobs fails them with code `node_outdated` and the message `Update RDK: npm install -g @retrodeck/rdk`. The dashboard shows that message on a Failed chip.
- **`/billing/portal`** returns the RetroDeck dashboard billing URL (there is no Stripe Billing Portal).
- **Wallet:** the node's payout address is read from Central (`walletAddress` on `GET /partners/links/:linkId/node`). It is set only with `rdk wallet <address>` on the node.
- **Pairing command names are unchanged:** `rdk link <code>` and `rdk init --link <code>`. `rdk init --link` needs no RetroDeck password, which matters because accounts ParlayLedger provisions get a random password plus a "Set your password" email.

## B. Kevan's decisions for SPEC 03 and 04

| # | Decision |
|---|---|
| B1 | **Odds: ingest multiple bookmakers.** The multi-book source becomes primary for the leagues it covers, subject to Kevan approving the cost estimate. `consensus` is the **median** American price across books at a snapshot (median line for spreads and totals, then the median price at that line), requiring at least 2 books. With fewer than 2 books, `oddsSource: 'consensus'` is unavailable for that market and the UI offers single books only. |
| B2 | **Soccer is out of v1.** No soccer leagues, no three-way moneyline, no draw grading. Remove `soccer` from every league list in the rdk module and the dashboard. |
| B3 | **Backtest minimum relaxed.** `STRATEGY_BACKTEST_MIN_SAMPLE = 20` (publish allowed at 20 or more). The `sample_below_minimum` warning still fires under 50 (`STRATEGY_BACKTEST_WARN_SAMPLE = 50`). Dashboard copy changes accordingly (section F). |
| B4 | **MCP tools ship.** ParlayLedger has no MCP server today, so SPEC 03 Phase 9 includes building one (section E). |
| B5 | **Region blocking is a no-op hook.** Production is not behind Cloudflare, and there is no geo source. `RDK_PUBLISH_BLOCKED_REGIONS` is read, but with no country available the check passes. Ship a `RegionResolver` interface with a null implementation, and keep the `region` blocked reason and copy in the code paths so a future resolver can switch it on. No GeoIP dependency. |
| B6 | **Age:** an attestation checkbox at activation (`I am {minAge} or older`), storing `age_confirmed_at` only. No birth date is stored. |
| B7 | **Android node app exists** (GitHub `Ascendant-Finance/rdk-mobile-node`). Keep the Android tab. Its copy and link come from the mobile-repo investigation (section G). |

## C. Defaults chosen where Kevan had no preference

- **Routes:** a literal `@Controller('v1/rdk')`. ParlayLedger has no global prefix, and adding one would break existing clients. The webhook receiver is `POST /v1/rdk/webhooks`.
- **Queue:** a Postgres outbox (`rdk_outbox`) drained by `@Cron` every 30 s for attestation PUTs and job enqueue retries. No Bull.
  - Use the hand-rolled overlap guard pattern from `stripe/subscription-sync.service.ts`.
  - All crons respect `LEDGER_SCHEDULERS_ENABLED`.
- **Schema:** hand-applied `scripts/rdk.sql` (BEGIN, `CREATE TABLE IF NOT EXISTS`, COMMIT, snake_case), including the immutability trigger. There is no TypeORM migration tool. Entities go in the `TypeOrmModule.forRoot({ entities })` list.
- **Users:** the PK is `users.uid` (uuid), so FKs point at `users(uid)`. The plan is `users.tier` (`free|starter|pro|corporate|executive`).
- **Email verified:** every rdk route checks `users.verified` itself, because signup issues a JWT before verification.
- **Publisher handle:** a column on `rdk_links` only (ParlayLedger has no username). Unique, `[a-z0-9_]{3,20}`, reserved list as SPEC 03, immutable.
- **Own pregame snapshots.** The rdk module does not trust "latest row by capturedAt" in `odds`, because that row is change-deduped, drops reversions and includes in-play rows. Instead:
  - Add `rdk_odds_snapshots(event_id, captured_at, kind, book, market, side, line, price_american, source_odds_id)`. Row kinds are `open` (first seen), `t60` (about 60 minutes before start), `t10` (about 10 minutes before start) and `publish` (captured when a pick is published).
  - A cron (every 5 min) writes `t60` and `t10` for upcoming events in supported leagues, from the freshest `odds` row per book and market with `capturedAt < startTime`.
  - Picks capture their own `publish` snapshot rows at submit.
  - Backtests and forward bets price at the **latest pregame snapshot** (`t10`, else `t60`, else `open`) for `price.source`.
  - Before rdk snapshots existed, backtests fall back to the last `odds` row with `capturedAt < startTime`. They carry a `legacy_pricing` warning when they do.
- **Start times.** A narrow core fix: event upserts update `startTime` when the event is not final and the provider's time differs. Comment the change, and flag it in the commit message because SafeParlay reads core events.
- **Cancelled and postponed games** are classified from `meta.statusShort` through the existing `stats/ingest/game-state.ts` classifier, never from `events.status`.
  - VOID covers `CANC` and abandoned games.
  - A postponed game (`PST` or `POST`) is void once 48 h have passed since `event_start_at` with no final.
- **Grading orientation:** snapshot the home and away team names on the publication at submit, and grade by name against the final `meta.scores` orientation.
- **`data_version`:** add an `rdk_data_versions` row written at the end of each odds sync and stats ingest run. `data_version` is the latest row's timestamp. A backtest cache hit needs an exact `(rules_hash, data_version)` match.
- **Allowances:** read `users.tier`. Note the known hole: `POST /user/subscription/update` lets any user set their own tier. It is flagged to Kevan as a separate ticket and is **not** fixed in this build.
- **Alerts:** use `SubZeroNotifier`. Fix it to read `SUBZERO_INGEST_KEY` lazily at send time (a small, safe fix to an existing bug).
- **IDs:** add the `ulid` package. Use Node built-in crypto for Ed25519. The `RDK_ATTEST_PRIVATE_KEY` format is base64 PKCS8 DER. Document how to derive the public key to register on the platform as `PL_ATTEST_PUBLIC_KEY` (base64 raw 32-byte key, or SPKI DER; match what the platform build expects by reading `retrodeck-docker-partners` `apps/api` attestation verification).
- **Field registry:** the draft table in the SPEC 03 Phase 0 report, sections 7 and 13, minus anything marked not available. `day_of_week` and `start_hour_local` use a fixed timezone per league (US leagues `America/New_York`). `season` is excluded (unreliable).

## D. Platform API contract the ParlayLedger client calls (as built in `feat/rdk-partners`)

The platform client must match the platform as built: request and response shapes, error codes and token format. Read `RetroDeckDocker/retrodeck-docker-partners/apps/api/src/partners/**` (read-only) and `docs/partners/RDK_PL_01_RDK_PLATFORM.md` there before writing `RdkPlatformClient`.
- The platform base URL is `RDK_PLATFORM_URL` (`https://api.retrodeck.ai`).
- Every partner route is on api, so **`RDK_CENTRAL_URL` is not needed**. Drop it.
- The error body is `{ code, message }`.

## E. MCP server (SPEC 03 Phase 9, now in scope)

- Use `@modelcontextprotocol/sdk` with streamable HTTP transport, mounted inside the Nest app at `POST /mcp` (plus `GET`/`DELETE` if the transport needs them). Stateless mode is fine.
- **Auth:** the existing customer `X-API-Key` (also accept `Authorization: Bearer <apiKey>`) through the same guard and quota as the data API (`ApiQuotaGuard`, customer metering).
  - Each tool call counts as one API call for metering.
  - Each call also counts against the calling user's rdk allowance: a query for `rdk_search_strategies`, a backtest for `backtest_strategy`.
  - Behind `RDK_MCP_TOOLS_ENABLED`. When false, `/mcp` returns 404.
- **Tools** have the locked names and descriptions from SPEC 03 Phase 9.
  - A user who has not activated RDK gets a tool error: `Activate RDK in your ParlayLedger dashboard to search the RDK network.`
  - `backtest_strategy` with rules needs no activation; with a `publicationId` it needs the publication to be public.
- Add a short README section on connecting an MCP client (URL plus API key header).

## F. Dashboard copy changes (SPEC 04 locked copy, amended)

Replacements; everything else stays verbatim.
- **Plan gate.** Shown on `publishBlockedReason = plan_limit` and on any `plan_limit_reached` error.
  - Heading: `Your RDK plan is full`
  - Body: `Your RDK plan has reached its storage limit ({chunksUsed} of {chunkLimit}). Upgrade your RDK plan to keep publishing. RetroDeck handles billing.`
  - Plan cards show **all** plans with `maxChunks` greater than the current limit, each displaying its storage limit.
- **Status `state` values.** `needs_plan` is renamed `plan_full` and means `chunksUsed >= chunkLimit`. `publishBlockedReason` values become `plan_limit | needs_node | node_offline_queue | region | age | null`.
- **Strategy builder:**
  - Sample under 20: `This strategy matched {n} games. Strategies need at least 20 to publish. Loosen a condition and run it again.`
  - `Publish strategy` is enabled at a sample of 20 or more.
  - Warning line for samples of 20 to 49: `Small sample. Treat this result with caution.` (existing copy).
- **Docs page:**
  - `A strategy needs at least 50 matching games` becomes `A strategy needs at least 20 matching games`.
  - `Publishing to the network needs an RDK plan that includes public sharing. Searching works on every plan.` becomes `Every RDK plan can publish to the network, up to its storage limit. Searching works on every plan.`
  - `Picks and Strategies` league lists exclude soccer.
- **Odds source select:** `Consensus` is offered only when at least 2 books price the market. Otherwise it is hidden, and the first book is the default.
- **Failed chip tooltip** shows the job error message (for example `Update RDK: npm install -g @retrodeck/rdk`).

## G. Android

The Android app (`com.retrodeck.android`) is not on Google Play yet and cannot pair: it has no pair-code screen and runs a vendored `@rdk/node` from before the partner work. Keep the `Android` tab, with this copy (no em dashes):
- Tab body: `Coming soon. The RetroDeck Android app is not on Google Play yet. For now, install RDK on your computer with one of the other tabs, then run the link command below.`
- Put the store URL `https://play.google.com/store/apps/details?id=com.retrodeck.android` in a constant `RDK_ANDROID_STORE_URL`, with a boolean `RDK_ANDROID_AVAILABLE = false`. When it is true, the tab shows the original SPEC 04 Android copy with the link.
- Docs page: in "Connect your node", step 1, replace `plus a link to the Android app` with `and the Android app is coming soon`. Where the docs mention an "Android phone", keep the wording.

## H. Odds ingest plan (B1 detail; cost checked 2026-10-18)

Multi-book data comes from **the-odds-api** (`regions=us`, which returns about 8 to 10 US books) on the **existing 20K-credit monthly plan**, using **snapshot mode only**. That is roughly 4k credits a month, so there is no new spend.
- **Do not flip `backup` to false.** In September the gap-filling behavior spent the month's credits in a day (`bbb10a9`). Add a separate `TheOddsApiSnapshotService` used only by the rdk snapshot cron.
- **Schedule:**
  - One opening sweep per league per day.
  - A `t60` and `t10` capture for upcoming events, batched per league with `commenceTimeFrom`/`commenceTimeTo` so there is one call per league per window, never one call per date or per game.
  - Markets `h2h,spreads,totals`. Leagues: every supported non-soccer league in season. That includes WNBA and MMA, which this restores.
- **Never fetch props** from the-odds-api in this mode.
- **Storage:** write into `rdk_odds_snapshots` (section C) with each book's key. Optionally also insert into `odds` through the existing ingest path so product surfaces get the books.
  - Consensus dedupes books across providers: one price per `book` per snapshot, preferring the the-odds-api row.
- **Guards:**
  - Log every call's credit headers (`x-requests-used` and `x-requests-remaining`) to the existing `usage` table.
  - Hard stop when remaining credits fall below `RDK_ODDS_CREDIT_FLOOR` (default 3000), so the backup failover keeps headroom.
  - Raise a SubZero alert once when the floor is hit.
- **Live 10-minute ingest is unchanged.** odds-api.io stays primary for product use.
- **Env:** `RDK_ODDS_SNAPSHOTS_ENABLED` (default `false` until Kevan flips it in prod), `RDK_ODDS_CREDIT_FLOOR`.
