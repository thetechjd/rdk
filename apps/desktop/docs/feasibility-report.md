# RDK Desktop — Prerequisite & Feasibility Report

_Status: pre-build diagnostics complete. This report gates the build per the app spec
("REPORT before building… do not build the app on a core that isn't cleanly consumable —
fix the core first")._

Monorepo audited: `/run/media/kevanj11/linux_drive1/RDK/rdk`
Target app home: `/run/media/kevanj11/linux_drive1/RDKDesktop` (this repo)

---

## 0. TL;DR

| Question | Answer |
|---|---|
| Is `@rdk/core` a clean, importable library? | **Yes.** Zero `console.log`/`process.exit`/prompts. Index + query are pure-core today. |
| Can the app import core directly (no CLI shell-out)? | **Yes for primitives.** The network/config/WS/account **glue is CLI-locked** and needs extraction. |
| Recommended core work before shipping? | Extract a headless **`@rdk/node`** package (both CLI + app import it). ~1–2 wk, mostly S/M pieces + 1 L. |
| Graph "retrieval edges" data ready? | **Partially.** `query_log` exists but is write-only, stores only the top-1 match. Needs a small core addition (join table + readers). |
| Windows feasible? | **Yes, ~a week.** onnxruntime is N-API (no rebuild); only `better-sqlite3` needs `electron-rebuild`. Windows service adapter already exists. |
| Biggest real blocker? | **macOS signing/notarization** — needs an Apple Developer ID cert. Unsigned = dead onboarding funnel. |
| Native modules bundlable in Electron? | **Yes**, with `@electron/rebuild` (better-sqlite3) + `asarUnpack` for `.node`/`.dll`. |

---

## 1. PREREQUISITE — Is `rdk-core` library-consumable?

**`@rdk/core` (`packages/rdk-core`) is a clean, pure library.** Verified: zero `console.log`,
`process.exit`, `readline`, or prompt usage. It exposes, ready to import today:

- `RDKIndexer` (`indexer.ts:43`) — index private/public, encrypts private with vault key.
- `RDKRouter` (`router.ts:55`) — full private→network→LLM-fallback query, tips enqueue, decrypt, query logging.
- `LocalStore` (`store/local-store.ts:44`) — SQLite: chunks, embeddings, tip queue, query log, stats.
- `LocalEmbeddingModel` / `embeddingModel` — all-MiniLM-L6-v2, 384-dim.
- `crypto` — `generateVaultKey`, `encrypt`/`decrypt`, `createKeyShare`/`unwrapKeyShare`, `keyToHex`/`keyFromHex`.
- `cosineSimilarity`, `chunker`, `cleaner`, `taxonomy`.

### The gap: orchestration is CLI-locked

The user-facing *workflows* are not in core — they live in `@retrodeck/rdk` (the CLI) and
`@retrodeck/mcp`, entangled with `ora`/`chalk`/`console`/prompts and a CLI-private config layer.

| Capability | Where it lives | Classification |
|---|---|---|
| index (private) / publish (public) | `RDKIndexer.indexDocument()` | **PURE CORE** ✅ |
| network query | `RDKRouter.query()` (router.ts:58) | **PURE CORE** ✅ |
| vault search / stats | `LocalStore.search()` / `getStats()` | **PURE CORE** ✅ |
| vault sync | `SyncService.syncOnce()` (`@retrodeck/mcp/sync-service.ts:44`) | CLI/MCP-coupled (only `console.error`) |
| config + vault-key crypto | `rdk-cli/src/config.ts` (AES-GCM machine key) | **CLI-ONLY** (and duplicated in `mcp/node.ts:475`) |
| WebSocket control channel | `rdk-cli/src/ws/*` (`RdkWebSocketClient`) | **CLI-ONLY** (singleton tied to `loadConfig`) |
| node lifecycle (serve) | `mcp.ts` + `@retrodeck/mcp` `RDKNode.init()` | **CLI-ONLY** (returns MCP text, `console.error`) |
| account login / me / upgrade | `account.ts` (RetroDeck HTTP) | **CLI-ONLY** |
| balance / earnings | HTTP `/tips/earnings`, `/balances/me` | **CLI-ONLY** (local pending tips are core) |
| promote private→public | `ws/handlers/promote-public.ts:9` | CLI-coupled (decrypt is core) |
| delete chunk | `LocalStore.deleteChunk()` + HTTP DELETE | core primitive + CLI wrapper |
| team / vault-key rotate | `team.ts` (crypto is core; rest HTTP+config) | CLI-coupled |
| **unpublish** | — | **DOES NOT EXIST** (public is immutable by design) |
| **pin / unpin** | — | **DOES NOT EXIST** anywhere |

**Note on the WS layer:** it is a *control channel* (`promote_public`, `delete_chunk`,
`vault_list` inbound; `heartbeat`, `chunk.indexed/deleted/public_complete` outbound). **Live
network queries do NOT arrive over the socket** — peer retrieval is HTTP: a consumer fetches
your public chunk via `GET /chunks/:id` on your Express server (`@retrodeck/mcp/http-server.ts`).
So "node live / serving" = the Express server + WS heartbeat, gated to public chunks.

### Recommended refactor — extract `@rdk/node`

Create `packages/rdk-node` (`@rdk/node`), a UI-agnostic orchestration layer both the CLI and the
Electron app import. Consume `@rdk/core` as-is. Do **not** reimplement orchestration on core
primitives in the app (guarantees drift — config decrypt is already duplicated once).

| Piece | Move | Effort |
|---|---|---|
| Config + machine-key crypto | `rdk-cli/config.ts` → `@rdk/node/config.ts` (delete `mcp/node.ts` dup) | **S** |
| WS client + protocol + events + handlers | `rdk-cli/ws/*` → `@rdk/node/ws/*` (console→callback) | **M** |
| SyncService | `@retrodeck/mcp/sync-service.ts` → `@rdk/node` | **S** |
| Chunk-serving HTTP | `@retrodeck/mcp/http-server.ts` → `@rdk/node` | **S** |
| **NodeController** (headless) | generalize `RDKNode` → return structured objects, keep store/router/indexer + vault watcher | **L** |
| promote / delete orchestration | `ws/handlers/*` → `@rdk/node` | **S** |
| account / team / earnings HTTP | extract UI-free `central-client.ts` | **M** |
| MCP stdio server | stays in `@retrodeck/mcp` (depends on `@rdk/node`) | — |
| service/* OS install | stays in CLI (Electron uses its own lifecycle) | — |

**Total ≈ 1 L + 2 M + 5 S (~1–2 weeks).** Only the `RDKNode` presentation/logic split is risky.

**Consumable AS-IS for a spike today:** all of `@rdk/core`, plus `SyncService` / `startHttpServer`
/ `RDKNode` from `@retrodeck/mcp` (with their `console.error` + MCP-shaped returns).

---

## 2. Graph data — the app's differentiator

Two edge types, very different readiness:

- **Semantic edges (file↔file cosine) — READY.** `LocalStore.getEmbedding()` + exported
  `cosineSimilarity`; chunks carry `sourcePath`. Buildable today with zero backend changes.
  (Private content is AES-encrypted at rest → label nodes with `title`/`summary` or decrypt.)
- **Retrieval edges (query→chunk, "RETRIEVED FOR") — needs a small core addition.**
  - `query_log` table exists (`local-store.ts:114`), written by the router on every query.
  - **Gap 1:** write-only — no `getQueryLog` / `getRetrievalsForChunk` reader exists.
  - **Gap 2:** stores only the **top-1** `matched_chunk_id`; the relation is many-to-many.
  - **Gap 3:** only router-driven queries are logged; CLI `networkQuery`/`vaultSearch` bypass the router.
  - **Fix (core, S):** add `retrieval_edges(query_id, chunk_id, rank, score)` (or extend `logQuery`
    to take all returned chunks), add `getQueryLog(limit)` / `getRetrievalsForChunk(id)` /
    per-chunk retrieval-count + earnings-rollup + `getAllEmbeddings()`, and route the app's queries
    through `RDKRouter.query()` so edges are captured consistently.

---

## 3. W1 — Native module Windows/Electron prebuilts

| Dep | Prebuilt Win? | Electron ABI | Verdict |
|---|---|---|---|
| `better-sqlite3` ^12 | Yes, w/ compile fallback | **V8/NAN — ABI-specific, must `@electron/rebuild`** | **The one blocker.** Missing prebuilt for the exact Electron ABI → `node-gyp` → needs **MSVC Build Tools + Python**. |
| `onnxruntime-node` 1.14 (via `@xenova/transformers`) | **Yes — fully shipped** (`bin/napi-v3/win32/{x64,arm64}/*.node,*.dll`) | **N-API v3 — ABI-stable, no rebuild** | **Not a blocker.** Runs under Electron unchanged. |
| `@xenova/transformers` ^2.17 | pure JS | — | fine |

**Action:** add `@electron/rebuild` at package time for `better-sqlite3`; `asarUnpack` the
`better_sqlite3.node` and `onnxruntime*.{node,dll}` (≈10 MB DLL) so they load outside the asar.
CI Windows runner needs MSVC v143 + Python as a fallback. (Corroborated by git history:
`drop Windows binary from release (pkg PE patching bug)` — Windows native packaging already broke once.)

---

## 4. W2 — Unix-only assumptions (core + CLI)

Mostly Windows-safe already: `path.join`/`os.homedir()` used throughout (43 sites), no hardcoded
`/Users`/`/home`, `RDK_HOME` override honored. Findings:

| File:line | Assumption | Windows impact | Fix |
|---|---|---|---|
| `rdk-cli/require-dep.ts:49,82,87` | `fs.symlinkSync(..., 'dir')` | **EPERM** without Admin/Dev Mode | Low — use `'junction'` on win32 |
| `rdk-cli/config.ts:48` | `mkdirSync(mode:0o700)` | mode ignored → `~/.rdk` not ACL-locked | Low (functional) / Med (ACL) |
| `rdk-cli/config.ts:90` | `writeFileSync(mode:0o600)` on key store | mode ignored → `config.json` (holds EVM key) world-readable | Low / Med (ACL) |
| `install-model.ts:26`, `require-dep.ts:280,289` | `execSync('npm install/rebuild …')` | runs, but native pkgs may need toolchain | Low / Med |
| `init.ts:319` | `~` expansion | harmless on Windows | none |
| core `embedding.ts`/`local-store.ts`/`config.ts` paths | `path.join(os.homedir(), '.rdk')` | **already safe** | none |

No `/bin/sh`, `chmod` calls, or hardcoded `/`-separators outside the intentionally-branched `service/`.

**For the app layer itself:** use `path.join`/`path.resolve`, `os.homedir()`, `app.getPath('userData')`
everywhere; platform-specific code behind an explicit `switch(process.platform)` with a `win32` branch;
UI degrades gracefully where a platform feature is unavailable.

---

## 5. W3 — Windows service + detached process

- Platform dispatch exists (`service/platform.ts` maps `win32→windows`, dynamic-imports adapter).
- **macOS:** LaunchAgent plist + `launchctl`. **Linux:** systemd user unit + `systemctl --user`.
- **Windows (`service/windows.ts`): a real, complete implementation — NOT a stub.** Builds Task
  Scheduler XML (UTF-16LE+BOM), `schtasks /Create /XML … /TN RetroDeck-RDK`, `/Run`/`/End`/`/Delete`/`/Query`.
  `<LogonTrigger>` (30s delay, current user, LeastPrivilege, RestartOnFailure 3×) = **auto-start at logon**,
  parity with launchd/systemd.
- **Detached spawn:** none in code — the daemon is delegated to the OS supervisor (launchd/systemd/Task
  Scheduler), which launches `rdk mcp:serve` fresh. The "win32 detach branch" question is moot.

**Recommendation:** Task Scheduler LogonTrigger is the right per-user, non-elevated choice (already done).
For the **Electron app**, prefer Electron's built-in `app.setLoginItemSettings` (simplest for a GUI app);
keep the Task Scheduler adapter for headless/pre-login serving. Small hardening (~0.5–1 day):
`status()` should surface PID/last-run (parse `schtasks /FO LIST /V`); add log redirection via a wrapper.

---

## 6. Signing / notarization

**Current posture: unsigned everywhere.** No Electron/notarization/codesign config exists (no app yet).
Today's distribution = unsigned `@yao-pkg/pkg` binaries + SHA256SUMS (integrity, not authenticity).

- **macOS — BLOCKER.** Needs **Developer ID Application** cert ($99/yr), `codesign --options runtime`,
  and **notarization** (`notarytool` + staple). Without it, Gatekeeper hard-blocks a downloaded `.app`
  for non-technical users. This is the single largest gating item. `electron-builder` handles it given
  the cert + `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`.
- **Windows — recommended.** Unsigned `.exe` runs but triggers SmartScreen "unknown publisher".
  Clear with **Authenticode** OV/EV cert (`electron-builder` → `signtool`).
- **Linux — none required.** AppImage/deb + SHA256 (optionally GPG-signed) suffice.

**Needed to ship signed:** (1) `electron-builder` config with `mac.notarize`, `win.certificateFile`,
`asarUnpack`; (2) Apple Developer ID cert + notary creds (**blocker**); (3) Windows OV/EV cert (recommended);
(4) `@electron/rebuild` step before packaging.

---

## 7. CLI → UI parity map

| CLI command | Backend | Desktop UI affordance | Status |
|---|---|---|---|
| `init` | CLI wizard | first-run Onboarding wizard | build |
| `vault:connect` | config | Onboarding / Settings → choose vault | build |
| `vault:index`, `index:chunk` | `RDKIndexer` ✅core | drag-drop / right-click → index privately | ready |
| `vault:publish`, `publish:chunk/url/file` | `RDKIndexer` public ✅core | right-click → publish; Inspector button | ready |
| `vault:sync`, `network:sync` | `SyncService` | Settings → force sync (+ auto) | extract |
| `vault:status`, `status` | `LocalStore.getStats` ✅core | status bar + Settings → Node | ready |
| `vault:search` | `LocalStore.search` ✅core | vault search | ready |
| `vault:set-public`/`list-public` | `config.publicFolders` | folder context-menu "mark public" | build |
| `network:join` | dep install | Onboarding (installs model deps) | build |
| `network:connect`, `test:connection` | WS/HTTP | Settings → node connect | extract |
| `network:query` | `RDKRouter.query` ✅core | Query bar (Cmd+K) | ready |
| `mcp:serve` | `RDKNode` | Settings → start node | extract (NodeController) |
| `mcp:validate`/`test` | MCP | Settings → diagnostics | build |
| `tips:enable`, `tips:status` | x402/config | Settings → Account → wallet | extract |
| `earnings`, `earnings:withdraw` | HTTP | Earnings tab + withdraw | extract |
| `account:login` | HTTP | Onboarding / Settings → sign in | extract |
| `account:upgrade` | browser | Settings → upgrade (browser handoff) | build |
| `account:apikey:rotate` | HTTP | Settings → Account | extract |
| `team:invite/accept/list/revoke` | crypto✅core + HTTP | Settings → Team | extract |
| `vault:rotate-key` | crypto ✅core | Settings → Vault → rotate key | ready-ish |
| `service:install/start/stop/status/uninstall` | service adapters | Settings → install as service / `setLoginItemSettings` | reuse |
| delete chunk | `LocalStore.deleteChunk` + HTTP | right-click / Inspector delete | ready |

### ⚠ Parity gaps (spec UI shows affordances with no backend)

1. **`unpublish`** — the Inspector mock shows an `[unpublish]` button and the IPC spec has
   `chunk:unpublish`, but **public chunks are immutable by design; no unpublish code exists.**
   Product decision needed: soft-hide (stop serving) vs delete-from-network + re-index private vs drop the button.
2. **`pin` / `unpin`** — Inspector mock shows `[pin]`, IPC spec has `chunk:pin`, but **no pin concept
   exists anywhere in core/CLI/central.** Decision: build a pin flag (new core field + central support) or drop it for v1.

Everything else maps cleanly.
