# RDK Desktop

An Obsidian-style desktop app for the RDK network: a three-pane file explorer plus
the graph neither Obsidian nor the web dashboard can show — **the relationship
between your files and what the network has queried.**

Built on Electron so the app and the CLI are two frontends over one core library
(`@rdk/core`): no shelling out, no stdout parsing, no drift. Native SQLite works
because it's a Node runtime.

> **Read [`docs/feasibility-report.md`](docs/feasibility-report.md) first** — it is
> the prerequisite audit (core consumability, Windows W1/W2/W3, signing, CLI parity)
> that gates this build, plus the `@rdk/node` extraction plan.

## Getting started (for testers/users)

Download-and-run guides, separate from the developer notes below:

- **macOS** — [`docs/getting-started-mac.md`](docs/getting-started-mac.md)
- **Linux** — [`docs/getting-started-linux.md`](docs/getting-started-linux.md)
- **Signing/notarization (macOS distribution)** — [`docs/signing.md`](docs/signing.md)

## Architecture

```
Renderer (React, sandboxed)      src/
     ↕  window.rdk  (contextBridge, contextIsolation ON, nodeIntegration OFF)
Preload                          electron/preload.ts
     ↕  ipcMain.handle
Main process (Node)              electron/main.ts
     └── NodeService (THE SEAM)  electron/node-service.ts
           ├── @rdk/core         index · query · search · graph · crypto  (pure-core primitives)
           └── @rdk/node         config · SyncService · CentralClient · NodeController · WS · http-server
                 ↕
           ~/.rdk/index.db (SQLite)  ·  RDK Central (HTTP/WS)
```

The `RdkApi` contract in [`shared/ipc.ts`](shared/ipc.ts) is the fixed boundary.
The config/network/sync/serve glue now lives in the shared **`@rdk/node`** package
(imported here via `workspace:*`, and by the CLI + `@retrodeck/mcp` too) — one
source of truth, no drift. The earlier spike `rdk-config.ts` duplication is gone.

## Prerequisites

This app lives in the RDK pnpm monorepo at `apps/desktop`. It imports `@rdk/core`
and `@rdk/node` via `workspace:*` — no `file:` references, no drift.

- Node ≥ 20, pnpm.
- From the monorepo root: `pnpm install`, then build the libs the app consumes:
  `pnpm --filter @rdk/core --filter @rdk/node build`.

## Develop

```bash
# from apps/desktop
pnpm run rebuild     # rebuild better-sqlite3 for Electron's ABI (once, or after an Electron bump)
pnpm run dev         # electron-vite dev with HMR
```

## Verify / build

```bash
npm run typecheck    # tsc for main (node) + renderer (web)
npm run build        # electron-vite production build → out/
npm run rebuild      # re-run @electron/rebuild for better-sqlite3 if you change Electron version
```

## Package (distributables)

```bash
npm run dist:mac     # .dmg + .zip   — REQUIRES Developer ID cert + notarization (see report §6)
npm run dist:linux   # AppImage + .deb — no signing needed
npm run dist:win     # nsis — configured but not shipped until W1 is green in CI
```

## Feature map (all wired through `window.rdk`)

| Feature | File | Backing |
|---|---|---|
| Vault tree (state dots, drag-drop, context menu, watch) | `src/panes/VaultTree.tsx` | `@rdk/core` RDKIndexer + disk walk |
| Graph (file+query nodes, semantic+retrieval edges, float) | `src/panes/GraphView.tsx` | embeddings + `retrieval_edges` (core) via d3-force |
| Content pane (decrypts private with the vault key) | `src/panes/ContentPane.tsx` | `LocalStore` + `crypto.decrypt` |
| Inspector (stats, RETRIEVED FOR, actions) | `src/panes/Inspector.tsx` | `getRetrievalsForChunk` |
| Query bar (Cmd/Ctrl+K) | `src/QueryBar.tsx` | `RDKRouter.query` |
| Earnings | `src/panes/Earnings.tsx` | Central `/tips/earnings` |
| Settings (node, vault, account, mcp, prefs) | `src/Settings.tsx` | node lifecycle + config |
| Onboarding wizard | `src/Onboarding.tsx` | `initNode` |

### Known parity gaps (surfaced honestly in the UI)

- **unpublish** — public chunks are immutable by design; the button is disabled with
  a tooltip (no backend exists).
- **pin / unpin** — no pin concept exists in core/central yet; disabled with a tooltip.

Both are one product decision away; see report §7.

## Companion change in `@rdk/core`

This app required small, additive, UI-agnostic methods in `../RDK/rdk/packages/rdk-core`
(the graph's retrieval edges were previously write-only):

- `store/local-store.ts` — new `retrieval_edges` table; `getQueryLog`,
  `getRetrievalsForChunk`, `getRetrievalEdges`, `getRetrievalCounts`, `getAllChunks`,
  `getAllEmbeddings`; `logQuery` now records the full ranked match set and returns the query id.
- `router.ts` — passes all matched chunks (not just the top hit) to `logQuery`.

The CLI is unaffected (all changes are additive). Validated under Electron's runtime.
