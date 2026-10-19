# Phase 0 — RetroDeck x ParlayLedger partner integration (SPEC 02, node side)

Discovery only. Nothing in this repo was modified except this file.
Snapshot: branch `feat/cocoa-hosted-agent` @ `148a2aa`, `@retrodeck/rdk` **1.14.2**
(`packages/rdk-cli/package.json:3`, also the version on npm). Desktop app `0.9.5`.

Path abbreviations used below:

- `cli/` = `RDK/rdk/packages/rdk-cli/src/`
- `node/` = `RDK/rdk/packages/rdk-node/src/` (`@rdk/node`)
- `core/` = `RDK/rdk/packages/rdk-core/src/` (`@rdk/core`)
- `mcp/` = `RDK/rdk/packages/rdk-mcp/src/` (`@retrodeck/mcp`)
- `central/` = `RetroDeckDocker/retrodeck-docker/apps/central-api/src/` (the deployed Central)

**Most important structural fact:** the config layer, the WebSocket client, the WS command
handlers, the sync service, link-node, and the HTTP server all moved out of the CLI into the
shared `@rdk/node` package. `cli/config.ts`, `cli/link-node.ts`, `cli/ws/*.ts`, and
`cli/ws/handlers/*.ts` are now 2–6 line re-export shims (e.g. `cli/ws/handlers/index.ts:2`
is `export * from '@rdk/node/ws/handlers/index'`). The desktop app (`apps/desktop/electron/node-service.ts:39,1183`)
consumes the same `@rdk/node` WS session. So any handler the spec adds lands in `node/ws/handlers/`
and runs in both the CLI and the desktop app.

---

## 1. Command registry

- **Framework:** `commander` ^12 (`cli/cli.ts:11`, `program = new Command()` at `:21`).
  It is a single flat file, with no command classes. Each `.command()` has an `.action()` that does a
  lazy `await import('./commands/<x>.js')` (keeps the cold start small). There are two styles:
  - grouped subcommands (`program.command('vault')` then `vault.command('index')`, `cli.ts:50–121`)
  - flat colon aliases on one line (`program.command('vault:index')…`, `cli.ts:123–133`).
    Most newer commands only exist in the colon form (`account:*`, `team:*`, `service:*`, `balance:*`).
- Built with esbuild into a single CJS bundle `dist/cli.js` (`package.json` `build` script), with heavy deps
  marked `--external` and installed on demand into `~/.rdk` by `cli/require-dep.ts`.
  `ws` is external and is a real dependency.

### `init` (`cli/cli.ts:30–46`, implementation `cli/commands/init.ts`)

```ts
program.command('init')
  .option('--email <email>') .option('--domain <domain>') .option('--vault <adapter>')
  .option('--path <path>') .option('--api-key <key>', 'Use an existing RDK API key')
  .option('--plan <plan>', 'Plan name', 'free')
  .option('--non-interactive') .option('-y, --yes') .option('--no-autostart') .option('--no-mcp-config')
  .action(async (opts) => { const { runInit } = await import('./commands/init.js'); await runInit(opts); });
```

- `runInit` (`init.ts:94`). **Headless branch** (`init.ts:101–126`): when `--non-interactive`/`-y` is set or
  there is no TTY, and no `--email` is given, it requires `--api-key` or `RDK_API_KEY`. It then writes a minimal config
  with `nodeId: process.env.RDK_NODE_ID ?? 'headless'` and returns. **It does not register a node,
  does not call `/nodes/auth`, does not create a vault key, and does not link to RetroDeck.**
- Interactive branch: it registers/logs in to the RetroDeck account (`api.retrodeck.ai /api/v1/auth/*`,
  `init.ts:134–323`). It can register the wallet with RetroDeck (`POST {RETRODECK}/api/v1/wallets`,
  `init.ts:416`). Then `runFullSetup` (`init.ts:711`) calls `POST {CENTRAL}/api/v1/nodes/register` (`:729`)
  and gets `{nodeId, apiKey}`. On failure it falls back to an offline `local-…` node. Next come `POST /nodes/auth` → JWT (`:755`),
  `POST /nodes/:id/link-retrodeck` (`:768`), `saveConfig(...)` (`:776`), and
  `ensureNodeLinked` (RetroDeck-side link, `:800`).
- A new `--link <code>` option would be added at `cli.ts:30–42` and threaded into `runInit`.

### `account:apikey`: does not exist

- Only **`account:apikey:rotate`** exists (`cli/cli.ts:375`) → `rotateApiKey()` (`cli/commands/account.ts:387–405`).
  It calls `POST {central}/api/v1/nodes/me/apikey/rotate` with `Authorization: Bearer <apiKey>` (the raw API key, not a JWT).
  It then saves the new key via `updateConfig({ apiKey })` and prints it once.
- CLAUDE.md ("Auth: JWT from `rdk account:apikey`") is stale. There is no command that prints the
  current key or a JWT. Other commands in the same family: `account`, `account:login`, `account:upgrade`, `account:relink` (`cli.ts:363–366`).

## 2. Config (`~/.rdk/config.json`)

Canonical implementation: `node/config.ts` (re-exported by `cli/config.ts:6`).

- Schema `RDKConfig` (`node/config.ts:11–59`): `nodeId`, `apiKey`*, `centralApiUrl`, `retrodeckUserId`,
  `retrodeckApiUrl`, `retrodeckAccessToken`*, `retrodeckRefreshToken`*, `emailVerified`, `ownerEmail`, `plan`,
  `vaultAdapter`, `vaultPath`, `domain`, `walletAddress`, `walletChain`, `mcpPort`, `createdAt`, `autoSync`,
  `syncIntervalMinutes`, `publicFolders`, `defaultVisibility`, `queryAutoRetrieve`, `queryMaxTipUsdc`,
  `vaultKeyHex`*, `sharedVaultKeys`* (* = encrypted at rest).
- Path: `$RDK_CONFIG_PATH` or `$RDK_HOME/config.json` or `~/.rdk/config.json` (`:61–65`). `rdkDir()` (`:83`) honours `RDK_HOME`.
- **Encryption:** AES-256-GCM, per value, not whole-file (`encryptValue`/`decryptValue` `:165–187`). The format is
  `enc:` + base64(iv12 ‖ tag16 ‖ ct). The key is `MACHINE_KEY = sha256(os.hostname() + os.userInfo().username)` (`:78–80`),
  or `RDK_CONFIG_ENCRYPTION_KEY` (64 hex) for hosted nodes (`:74–77`). A config moved to another machine fails to decrypt.
  Values without the `enc:` prefix are read as plaintext (`:175`).
- Field-level: `saveConfig` (`:139–158`) spreads `...config` and then explicitly encrypts only the five secret fields.
  It writes with mode 0600 (`:157`). `updateConfig` (`:160`) does load → shallow merge → save. There is no file locking.
  `rdk mcp:serve`, the desktop, and a CLI command can race.
- Env-only mode: if there is no config file but `RDK_API_KEY` is set, `loadConfig` synthesises one (`:103–113`).
- `rdk config:set` uses an allowlist (`cli/commands/config.ts:8–60`): `query.autoRetrieve`, `query.maxTip`, `domain`,
  `autoSync`, `syncIntervalMinutes`, `defaultVisibility`, and others. Nested objects are not supported.
- **Where `partners` goes:** add `partners?: { parlayledger?: {...} }` to `RDKConfig` in `node/config.ts:11–59`.
  Non-secret fields round-trip as-is through the spread. **Any secret in the block (a partner token or link secret) must be added
  to the explicit encrypt list in `saveConfig` and the decrypt list in `loadConfig` (`:117–126`)**, or it is stored in plaintext.
  The env-only synthesised config (`:105–113`) will have no `partners` block.

## 3. WebSocket

Real files: `node/ws/protocol.ts`, `node/ws/client.ts`, `node/ws/handlers/index.ts`, `node/ws/ownership.ts`.
Server counterpart: `central/websocket/ws.gateway.ts`, `central/websocket/ws.protocol.ts`.

- **Envelope** (`node/ws/protocol.ts:4–10`): `{ type, id?, replyTo?, data?, error?: {code,message} }`.
- **Inbound commands** (`protocol.ts:13–18`): all are namespaced **`command.*`**: `command.promote_public`,
  `command.delete_chunk`, `command.vault_list`, `command.fetch_content`, `command.fetch_document`.
- **Outbound events** (`:21–25`): `node.heartbeat` (every 30 s, `client.ts:186`), `chunk.indexed`, `chunk.deleted`,
  `chunk.visibility_changed`.
- **Registration** (`node/ws/handlers/index.ts:9–21`): a static map `Record<string,(data)=>Promise<unknown>>` plus
  `dispatchCommand(msg)`, which throws `Unknown command` for unmapped types. To add a handler, import it and add a map entry.
- **Reply shape** (`node/ws/client.ts:197–235`): `handleMessage` dispatches **only types that start with `command.`**
  (`:218`). On success it sends `{ type: 'ack', replyTo: <msg.id>, data: <handler result> }` (`:225`). On throw it sends
  `{ type: 'error', replyTo, error: { code: 'COMMAND_FAILED', message } }` (`:228–232`). Any other type is ignored
  silently (except `ready`, `ack`, and `error`).
- **Central side:** `sendCommand(nodeId, type, data, timeoutMs = 10_000)` (`central/websocket/ws.gateway.ts:556`) creates
  `id = cmd_<ts>_<rand>` (`:594`), waits for an `ack`/`error` with a matching `replyTo` (`:176–185`), and tries other
  live sessions of the same node only on transport errors (timeout or disconnect). Central now keeps **all** sessions per node
  (4001 "replaced" is legacy, `client.ts` comment at top of class).
- **Auth:** on every connect, `POST {central}/api/v1/nodes/auth` with `Bearer <apiKey>` → `{jwtToken}` (`client.ts:56–70`).
  The socket opens to `ws(s)://<central>/ws/internal/node` with `Authorization: Bearer <jwt>` (`client.ts:258`).
  Offline `local-*` nodes get no client (`client.ts:~257`).
- **When is the socket open?** Not for every process. The client is a lazy singleton (`getWsClient`). A session is started by:
  - `rdk mcp:serve` (`cli/commands/mcp.ts:69–74`, `startWsSession({app:'mcp'})`). This is the long-lived path, and it is also what
    `rdk service:install` / `mcp:serve --detach` run (`cli/commands/service/platform.ts:51–54`, `service/index.ts:51`).
  - `rdk query` only for the duration of the command (`cli/commands/query.ts:133–139, 314`, `withWsConnection`).
  - the desktop app (`apps/desktop/electron/node-service.ts:1183`, `electron/serve.ts:54`), and `NodeController.start()`
    (`node/node-controller.ts:155`).
  - Every other CLI command (including `vault:index`, `publish:*`, and `link`) does **not** hold a socket. The header comment at `client.ts:2`
    ("Runs only within mcp:serve") is now outdated, but the substance holds: a partner node must run `mcp:serve`, the service, or the desktop app to receive jobs.

## 4. Indexing a single file as public

- The primitive is **`RDKIndexer.indexDocument(doc: Document)`** (`core/indexer.ts:83–324`). `Document` (`:20–46`) carries
  `content, title, docTitle?, sourcePath?, sourceAdapter?, domain?, categories?, isPublic?, localOnly?, supersedes?,
  version?, derivedFrom?`. The pipeline is: rate-limit token (`:110–119`) → clean (rejects <50 chars, `:122–125`) → chunk →
  `saveDocument` (full doc, `:139`) → embed / dedup (rejects a document whose chunks are all near-duplicates, `:237–246`) →
  `saveChunk` per chunk (`:279–300`) → `onChunkIndexed` callback → if `syncToNetwork && !localOnly`,
  **`syncTocentral(indexedChunkIds)`** (`:316–318`, `:346–440`).
- The CLI wrapper that takes a file path plus visibility is `ingestFile(filePath, isPublic, domain?, localOnly?)`
  (`cli/commands/publish.ts:135–166`). It is module-private and UI-bound (ora spinner, `process.exit(1)` on a missing file).
  It does **not** pass `categories`. `publishFile` (`:174`) = `ingestFile(path, true)`. `getIndexer()` (`:13–32`) builds
  the indexer with `syncToNetwork: true` and `onChunkIndexed: pushChunkIndexed`.
- `promote-public` (`node/ws/handlers/promote-public.ts`) flips an existing private chunk only and does not index.
  The vault adapters (`rdk-adapter-filesystem`, `-obsidian`) index whole vaults via `indexAll`.
- **Gaps for `publish_doc`:**
  - `indexDocument` returns `IndexResult {chunksIndexed, chunksSkipped, filesProcessed, errors, categories}`
    (`core/adapters/interface.ts:30–36`). It does **not** return chunk ids. `indexedChunkIds` is a local variable (`indexer.ts:88`).
    To reply with chunkHashes, either extend `IndexResult` or look them up afterwards via `store.getVersions(sourcePath)` (`core/store/local-store.ts:571`).
  - The local chunk id **is** the chunkHash (`chunkHash: chunk.id`, `indexer.ts:358`, `chunkIdentity(documentHash,text)` `:65`).
    There is no separate node-side chunkId. Central has its own row ids.
  - Index rate limit: burst **20** documents, refill **200/h** (`core/query/pipeline.constants.ts:45–46`). It throws
    `Index rate limit exceeded` when exhausted. A bulk partner backfill will hit this.
  - Sync errors surface in `errors` (`indexer.ts:319–321`). Partial acceptance (plan limit) throws "Central did not accept N chunk(s)" (`:434`).

## 5. Sync payload

There are **three** independent payload builders. All three need `externalPartner` / `externalRef`:

1. `RDKIndexer.syncTocentral` — `core/indexer.ts:355–385` (the publish-time path; it omits `derivedFromHash` and `chunkTokens`).
2. `SyncService.syncOnce` — `node/sync-service.ts:119–147` (background / auto-sync, the most complete builder).
3. `vaultSync` — `cli/commands/vault.ts:272–298` (the `rdk vault:sync` loop, one chunk per request; it also omits documentHash, chunkIndex, chunkCount, derivedFromHash, and riskScore).

- Attach the two fields next to `sourcePath`/`sourceAdapter` in each builder. They read from new `StoredChunk` fields.
- **Central's DTO will strip them** until it is updated: `ValidationPipe({ whitelist: true, forbidNonWhitelisted: false })`
  (`central/main.ts:31–34`), and `SyncChunkDto` (`central/chunks/dto/*.ts:12–88`) has no such fields. Unknown fields are
  dropped silently, not rejected.
- Central applies plan chunk limits to every new public chunk (`central/chunks/chunks.service.ts:69–128`), so **partner docs
  count against the user's plan quota** unless Central exempts them.

## 6. Delete path

- **CLI:** `vaultDelete(target, {yes})` (`cli/commands/vault.ts:389–430`). `rdk delete <pathOrChunkId>` (`cli/cli.ts:127`) resolves
  live chunks by path (`store.getVersions(path.resolve(target))`) or by a 64-hex id. It calls
  **`SyncService.deleteOnCentral(chunkHash)`** (`node/sync-service.ts:322–335`) → `DELETE {central}/api/v1/chunks/:chunkHash`
  with a node JWT, and then `store.deleteChunk(id)` (`core/store/local-store.ts:552`).
- **WS:** `deleteChunkHandler` (`node/ws/handlers/delete-chunk.ts:6–45`) does its own auth, calls `DELETE /api/v1/chunks/:id` (`:21`)
  as best-effort, deletes the local row, and pushes `chunk.deleted`.
- Central: `@Delete(':chunkHash')` (`central/chunks/chunks.controller.ts:154–161`). Public rows are retired (history kept). Private rows are hard-deleted.
- **Gap:** `LocalStore` has **no `deleteDocument`**. The `documents` table row (full content, written at `indexer.ts:139`)
  survives a chunk delete, and `fetch_document` (`node/ws/handlers/fetch-document.ts:36`) still serves it by hash.
  `unpublish_doc` must also remove the document row and the managed file.

## 7. Headless / agentic mode today

- **stdio MCP:** `rdk mcp:serve` → `startMcpServer()` (`mcp/server.ts:84–150`, `StdioServerTransport` at `:148`). Its six tools are
  `rdk_query`, `rdk_index`, `rdk_index_url`, `rdk_index_vault`, `rdk_status`, `rdk_earnings` (`mcp/server.ts:13–82`).
  Side effects: it polls the vault every 20 s and reindexes (`mcp/node.ts:179–234`) and auto-syncs.
- **HTTP:** `startHttpServer` (`node/http-server.ts`, started by `mcp:serve` at `cli/commands/mcp.ts:49–54`) exposes only
  `GET /health`, `GET /.well-known/mcp.json`, and **`GET /chunks/:chunkId` (public chunk content, no auth)**. It listens on
  `mcpPort` (4242, then tries up to +10) **on all interfaces** (`app.listen(port)`, `:288`, no host argument). It has no query or POST API.
- **Non-interactive CLI:** `RDK_API_KEY` / `RDK_CONFIG_PATH` / `RDK_NON_INTERACTIVE=1` / `CI=true` (`cli/interactive.ts`,
  `node/config.ts:95–113`). `rdk query --json [--auto --max-tip <usd> | --select <chunkId>]` is the current
  machine-readable query surface.
- Entry point: `cli/cli.ts` (bin `rdk` → `dist/cli.js`). The background service re-invokes `rdk mcp:serve`
  (`cli/commands/service/platform.ts:51–54`). Logs go to `~/.rdk/logs/rdk.{out,err}.log` (`service/index.ts:43–46`; note this uses
  `os.homedir()`, not `RDK_HOME`).
- An `api:serve` on 127.0.0.1:7841 does not conflict with anything existing, but it would be a **second** listener next to the 0.0.0.0:4242 one.

## 8. Network query and tips

- **Path:** `unifiedQuery` (`cli/commands/query.ts:64–413`) → `RDKRouter.query` (`core/router.ts:212`) → local vault first →
  `queryNetwork` (`router.ts:442–505`): `POST {central}/api/v1/query` with `{queryText, embedding, topK: max(20,topK*4),
  domain, includeUnavailable: true, previewOnly, selectedChunkId?}` (`:448–472`). Content comes back **from Central**
  (Central asks the owning node over WS via `command.fetch_content` / `fetch_document`). The old peer-HTTP fetch
  (`fetchChunkContent`, `:510–528`) is a fallback.
- Two-phase contract: phase 1 `networkPreviewOnly: true` (free metadata and previews, `query.ts:137–139`). Phase 2
  `selectedNetworkChunkId` retrieves one document and settles its tip (`query.ts:314–316`).
- **Tips are not paid via rdk-x402.** Central settles them server-side from RetroDeck credits and returns
  `settledByCentral: true` (`central/query/query.service.ts:305,486`). The router enqueues a local x402 tip only if
  `settledByCentral !== true` (`core/router.ts:319–338`). `@retrodeck/x402` is imported by **no** runtime code (only listed in
  `cli/require-dep.ts`). `cli/commands/tips.ts:64–68, 86–89` says outright that the local x402 settlement loop "is not wired up".
- **Existing tip ceiling:** `--max-tip <usd>` / config `queryMaxTipUsdc` (`config:set query.maxTip`). It is enforced client-side only
  in `query.ts:290–307`: before phase 2, the **selected** document's preview `tipUsdc` is compared to the cap, and the command returns
  `error: 'tip_exceeds_max'` with nothing charged. It does not apply to interactive picks (`:292`). Central's `NetworkQueryDto`
  (`central/query/query.controller.ts:8–29`) has **no** max-tip field and **no category/partner filter** (only `domain`,
  `topK`, `excludeNodeId`, `previewOnly`, `selectedChunkId`, `queryTerms`). So the cap is a pre-check against the preview price,
  not a server-enforced ceiling.
- The MCP `rdk_query` tool uses a different pipeline (`core/query/pipeline.ts` via `mcp/node.ts:277–297`) with no tip cap.

## 9. Android

- There are no Android references in `RDK/rdk` (packages, apps, docs), `RetroDeckDocker` apps, the dashboard (except a demo-node
  label in `RetroDeckDashboard/.../network/demoNodes.ts:36`), or the landing page. No Android/mobile repo exists under
  `/run/media/kevanj11/linux_drive1`. No package in this monorepo is consumed by an Android app. No Play Store link was found.
  If an Android node exists, it lives elsewhere. The natural shared surfaces would be `@rdk/core` and `@rdk/node`
  (Node-only: better-sqlite3, ws, express, `@xenova/transformers`).

---

## Extra items for the dashboard spec

**Install commands** (`packages/rdk-cli/README.md:12–23`; landing page `retrodeck-landing-page/app/docs/install/page.tsx:22–46`,
`components/CTA.tsx:84`):

```bash
npm install -g @retrodeck/rdk
brew tap thetechjd/rdk && brew install rdk
curl -fsSL https://raw.githubusercontent.com/thetechjd/rdk/main/install.sh | bash
```

- Windows: `install.ps1` exists (`RDK/rdk/install.ps1`). Its header says `irm https://rdk.network/install.ps1 | iex`, but
  `rdk.network` has no DNS (`node/config.ts:66–72`). `install.sh:8` has the same stale `rdk.network` usage line. The landing page
  shows no Windows command. The working form would presumably be
  `irm https://raw.githubusercontent.com/thetechjd/rdk/main/install.ps1 | iex` (unverified).

**Wallet command:** `rdk wallet <address> [--chain base|ethereum|polygon]` (`cli/cli.ts:306–313` → `setWallet`
`cli/commands/tips.ts:12–28`). `rdk tips:enable` also prompts for one. **It only writes `walletAddress`/`walletChain` to local
config.** It does not tell Central or RetroDeck. Central learns the wallet only at `nodes/register` time (`init.ts:736`,
`central/nodes/nodes.service.ts:77,92`). RetroDeck learns it only through init's `POST /api/v1/wallets` (`init.ts:416`). Withdrawals
send the local address per request (`cli/commands/account.ts:545`, `cli/payments.ts:380–400` → `POST /api/v1/balances/withdraw`).

**Local SQLite:** yes. `~/.rdk/index.db` (`$RDK_HOME` honoured), better-sqlite3, WAL (`core/store/local-store.ts:128–140`).
Tables: `chunks`, `chunk_embeddings`, `documents`, `tip_queue`, `query_log`, `retrieval_edges`, `chunk_minhash`,
`index_rate_buckets`, `schema_versions`. **Migration path:** ad-hoc idempotent `ALTER TABLE chunks ADD COLUMN … ` wrapped in
try/catch inside `init()` (`:263–290`), plus a versioned `schema_versions` row (`component='query_pipeline'`,
`QUERY_PIPELINE_SCHEMA_VERSION = 2`, `:12–14, 140–160`). New `external_partner`/`external_ref` columns fit either pattern.
They must also be added to the `CREATE TABLE` (`:212–236`), `saveChunk` INSERT/UPDATE (`:337–400`), `rowToChunk` (`:1004`), and
`StoredChunk` (`:16–80`). `getStats()` (`:848`) already returns `publicChunks` for `ping`.

**CLI ↔ Central auth:** a long-lived node API key (from `POST /api/v1/nodes/register`, stored encrypted) is exchanged via
`POST /api/v1/nodes/auth` (`Authorization: Bearer <apiKey>`) for `{jwtToken}`. The JWT lasts about 1 h, and callers cache it for 55 min
(`node/sync-service.ts:337–348`, `core/router.ts:428–440`). Each module fetches its own JWT. There is no shared token cache.
`account:apikey:rotate` and `earnings` send the raw API key as the bearer.

---

## Assumptions the codebase contradicts

1. **`src/ws/protocol.ts` / `src/ws/handlers/index.ts` in rdk-cli are shims.** The real code is in `packages/rdk-node/src/ws/`.
   A `partner-job.ts` handler belongs in `rdk-node/src/ws/handlers/`, and it will also run inside the desktop app.
2. **Message names `partner_job` / `partner_job_result` do not fit the protocol.** The node only dispatches types prefixed with
   `command.` and silently drops everything else (`node/ws/client.ts:218`). Replies are always `{type:'ack'|'error', replyTo}`,
   never a typed `*_result`, and Central's `sendCommand` awaits exactly that (`ws.gateway.ts:176–185, 556`). Use
   `command.partner_job` (or one command per op) and return the result as the `ack` `data`.
3. **`POST /api/v1/nodes/link` already exists, on retrodeck-api, not Central.** `ensureNodeLinked` (`node/link-node.ts:89–129`)
   calls `{api.retrodeck.ai}/api/v1/nodes/link` with a RetroDeck user token, and that endpoint is **not idempotent**. Central has
   no `/nodes/link` (`central/nodes/nodes.controller.ts:53–110`). "link" already means "link node to RetroDeck account"
   (`account:relink`, `link-node.ts`), so `rdk link <code>` overloads that term.
4. **"Tip via rdk-x402" is not how tips work.** Central settles tips from RetroDeck credits (`settledByCentral`), and x402 is dead code
   at runtime. A per-query `maxTipUsdc` can only be enforced client-side against the preview `tipUsdc` (as `query.ts:290–307`
   does), or by adding a field to Central's `NetworkQueryDto`.
5. **"Fetch content" is not a separate client step.** Central fetches content from the owning node over WS during phase 2.
   The partner `/v1/query` must use the two-phase preview → select flow, so that skipped (over-cap) results are never charged. That flow
   retrieves **one document per selection**, so N results means N phase-2 calls and N tips.
6. **Central query has no category/partner filters.** `/v1/query` "with filters" needs a Central DTO change. Today only `domain` exists.
7. **The sync payload has three builders, not one `src/core/sync.ts`.** There is no `src/core/` in the CLI. Central's whitelist
   ValidationPipe silently strips `externalPartner`/`externalRef` until `SyncChunkDto` gains them.
8. **The socket is not open whenever the node process runs.** It is open only under `mcp:serve`/service, desktop, or during `rdk query`.
   A plain `rdk link` cannot receive jobs.
9. **`indexDocument` does not return chunk ids**, and the indexer has a 20-document burst rate limit and whole-document dedup rejection.
10. **"Payout wallet is set only via the CLI's wallet command"**, but `rdk wallet` never propagates to Central or RetroDeck. Payouts
    use the local value per withdrawal. ParlayLedger-related payouts that Central must pay out need a sync step that does not exist.
11. **`rdk account:apikey` does not exist** (only `:rotate`). CLAUDE.md is stale here, and on `api.rdk.network`
    (the real URL is `https://rdk.retrodeck.ai`, `node/config.ts:68`).
12. **Unpublish must also delete the `documents` row.** `LocalStore` has no `deleteDocument`, and `fetch_document` keeps serving
    the full content otherwise.
13. The spec says partner docs are "excluded from vault adapters". They are already excluded **if** `~/.rdk/partners/` sits outside
    `vaultPath`. All scanners skip dot-paths (`mcp/node.ts:592`, filesystem adapter chokidar `ignored: /(^|[/\\])\../`, glob
    default). They would only be at risk if `vaultPath` itself is under `~/.rdk`. Note that `rdk delete <path>` uses `path.resolve` on
    `source_path`, so partner docs should be indexed with an absolute `sourcePath` and `sourceAdapter: 'partner:parlayledger'`.

## Open questions for Kevan

1. Is the Central counterpart (link endpoint, `command.partner_job` dispatch, `SyncChunkDto` fields, query filters,
   optional `maxTipUsdc`) in scope for this spec, or a separate SPEC? Which Central route name avoids the retrodeck-api `/nodes/link` clash
   (e.g. `POST /api/v1/partners/link`)?
2. Rename the WS message to `command.partner_job` with `ack` replies (recommended), or extend `client.ts` to accept a new
   non-`command.` type plus a `partner_job_result` reply? The latter requires Central gateway changes too.
3. Should partner chunks count against the user's plan network-chunk limit? Free-tier nodes may hit the limit, which would make partner publishes fail.
4. Must the node run `mcp:serve`/service for partner jobs? Should `rdk link` offer `service:install`? Should the new `api:serve`
   also hold the WS session (so it can be the single long-running process), or must it run alongside `mcp:serve`?
5. Should `api:serve` share a process with the existing 0.0.0.0:4242 HTTP server, and should the existing `/chunks/:id` stay bound to all interfaces?
6. Where should the partner `maxTipUsdc` be enforced: client-side against preview `tipUsdc` (no Central change, but trusts the preview
   price), or server-side in Central's query settlement?
7. Wallet: should `rdk wallet` start syncing to Central and RetroDeck (new endpoint) so the dashboard and ParlayLedger can see the payout
   address, or is the local-only value acceptable?
8. Which partner fields are secrets (link token, shared secret)? They need explicit encryption in `saveConfig`/`loadConfig`.
9. Should `ping`'s `cliVersion` be the CLI or the desktop version? `@rdk/node` doesn't know which host it runs in, so the version must be injected.
10. What is the Android node app: does it exist yet, and where? No code or store link was found anywhere on this drive.
11. Bulk backfill: should partner publishes bypass or raise the 20-doc burst / 200-per-hour index rate limit?
12. Should Central's WS command timeout for publish (default 10 s) be raised? First-time embedding-model load plus indexing a long doc can exceed it.
