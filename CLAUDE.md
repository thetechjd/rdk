# RDK — Retrieval Development Kit
## CLAUDE.md — Build Context for Claude Code

---

## What This Is

RDK is a distributed knowledge infrastructure. Three tiers:
1. **RDK Central** (`apps/central-api`) — NestJS + PostgreSQL + pgvector. Node registry, chunk sync, network query routing, Stripe billing, tips ledger.
2. **RDK Node** (`packages/rdk-mcp`) — MCP server. Each user runs one. Exposes `rdk_query`, `rdk_index`, `rdk_index_url`, `rdk_index_vault`, `rdk_status`, `rdk_earnings` tools.
3. **RDK Client** (`packages/rdk-core`, `packages/rdk-cli`) — SDK + CLI. `rdk init`, `rdk mcp:serve`, `rdk vault:index`, etc.

The key value: query router checks private vault → public network → LLM fallback. Collapses token spend 80-90% as network matures.

---

## Monorepo Structure

```
rdk/
├── packages/
│   ├── rdk-core/              ✅ DONE — router, indexer, chunker, cleaner, local SQLite store, embedding model
│   ├── rdk-mcp/               ✅ DONE — MCP server (all 6 tools), HTTP .well-known endpoint
│   ├── rdk-cli/               ✅ DONE — all commands (init, vault:*, network:*, mcp:*, publish:*, account, earnings)
│   ├── rdk-x402/              ✅ DONE — x402 tip client, batch settlement, ethers.js v6
│   ├── rdk-adapter-filesystem/ ✅ DONE
│   ├── rdk-adapter-obsidian/  ✅ DONE — wikilinks, frontmatter, backlink graph
│   ├── rdk-adapter-logseq/    🔲 TODO — block format, page refs, journals
│   └── rdk-adapter-notion/    🔲 TODO — Notion API, database polling
├── apps/
│   ├── central-api/           ✅ DONE — full NestJS, all endpoints, migrations, billing, cron
│   ├── central-dashboard/     🔲 TODO — Next.js dashboard
│   └── billing/               🔲 TODO — Stripe add-on management UI
├── docker-compose.yml         ✅ DONE
└── CLAUDE.md                  ← you are here
```

---

## Stack

- **Runtime**: Node.js 22, TypeScript throughout, ESM (`"type": "module"`) except `central-api` which uses CommonJS (NestJS requirement)
- **Monorepo**: pnpm workspaces + Turborepo
- **Central API**: NestJS + PostgreSQL + TypeORM + pgvector
- **Local store**: better-sqlite3 (pure JS cosine similarity — no native extension needed)
- **Embeddings**: `@xenova/transformers` all-MiniLM-L6-v2, 384-dim, quantized (~23MB)
- **MCP**: `@modelcontextprotocol/sdk`
- **Payments**: Stripe (subscriptions) + ethers.js v6 (on-chain USDC tips)
- **Auth**: JWT + bcrypt-hashed API keys

---

## Key Design Decisions Already Made

### Local Vector Store
Pure JS cosine similarity over all chunks. No sqlite-vec extension (avoided native compilation complexity). Works fine up to ~50K chunks. If performance becomes an issue, add sqlite-vec later.

### API Key Auth Flow
1. `rdk init` → `POST /api/v1/nodes/register` → receives `{ nodeId, apiKey }`
2. API key shown ONCE in terminal. Stored encrypted at `~/.rdk/config.json` (AES-256-GCM, machine-derived key).
3. To get JWT: `POST /api/v1/nodes/auth` with `Authorization: Bearer <apiKey>` → receives `{ jwtToken }`
4. All subsequent API calls use JWT.
5. MCP server (inbound from Claude) needs NO auth — it's local stdio, same as all Claude Desktop MCP servers.

### Content Privacy
Raw document content NEVER leaves the node. Central stores: embeddings + summaries + metadata only. See the sync table in the spec.

### Tip Architecture
Tips are `rdk-x402` package responsibility — entirely outside Claude session. Consumer node queues tips locally (SQLite), batch-settles hourly or when $1 accumulates. On-chain USDC on Base (default). Central records tip for quality scoring after settlement.

### Plan Enforcement
- Free/Starter/Pro: hard 429 at limit
- Enterprise: soft limit → Stripe metered overage billing
- Free tier cannot contribute to public network (can only consume) — bootstraps demand

### Embedding Model Cache
Downloaded to `~/.rdk/models/` on first use. ~23MB (quantized). Node.js 22 / ESM dynamic import pattern.

---

## What's Left to Build

### Phase 5 — Logseq Adapter

```typescript
// packages/rdk-adapter-logseq/src/index.ts
// Similar to filesystem adapter, but:
// - pages/*.md and journals/*.md
// - Parse Logseq block format: lines starting with "- " are blocks
// - Handle ((block-uuid)) references — resolve to block content
// - Handle [[page-links]] — same as Obsidian wikilinks
// - Handle :PROPERTIES: drawers in org-mode style
// - Exclude journals by default (config: includeJournals: false)
// - graphPath config: e.g. ~/logseq
```

### Phase 5 — Notion Adapter

```typescript
// packages/rdk-adapter-notion/src/index.ts
// - Connect via Notion API (requires integrationToken)
// - Fetch selected databases and pages (databaseIds config)
// - Handle rich text, tables, toggles, callouts
// - Poll every 15 minutes (Notion has no webhooks)
// - Config: { integrationToken: 'secret_...', databaseIds: ['uuid', ...] }
// - IMPORTANT: content leaves Notion servers to local node — warn user
```

### Phase 7 — Dashboard (`apps/central-dashboard`)

Next.js 15 App Router. Pages:
- `/dashboard` — node status, chunk count, query count, earnings summary
- `/dashboard/vault` — indexed documents, categories, quality scores table
- `/dashboard/earnings` — tip history, pending withdrawals, wallet config
- `/dashboard/network` — peer nodes list, contribution domain ranking
- `/dashboard/billing` — current plan, upgrade CTA, invoice history
- `/dashboard/settings` — node config, API key management, wallet settings

Stack: Next.js, Tailwind, shadcn/ui. Auth: JWT from `rdk account:apikey` stored in localStorage. API calls to `NEXT_PUBLIC_API_URL`.

### Phase 7 — Billing Add-ons

Add to `apps/central-api`:
- `POST /api/v1/billing/addon` — team nodes ($19/mo), storage expansion ($9/mo per 10K chunks), priority boost ($49/mo per domain)
- `GET /api/v1/billing/addons` — list active add-ons for node
- Stripe metered billing for enterprise overages (already scaffolded in BillingService, needs wiring)
- Stripe price ID env vars: `STRIPE_PRICE_STARTER_MONTHLY`, `STRIPE_PRICE_PRO_MONTHLY`, etc.

### Phase 8 — Quality + Taxonomy

Add to `apps/central-api/src/chunks/`:
- `quality.service.ts` — event-driven quality score updates (retrieved, engaged, tip_settled, llm_fallback, stale)
  - Wire to query endpoint: after each query match, fire async quality update
  - Wire to tips endpoint: `tip_settled` event on `POST /api/v1/tips/record`
- Controlled taxonomy endpoint: `GET /api/v1/taxonomy` — returns current TAXONOMY object from rdk-core, synced to nodes

---

## Running Locally

```bash
# Start infrastructure
docker-compose up -d postgres redis

# Run central API in dev
cd apps/central-api
cp .env.example .env  # fill in secrets
pnpm dev

# Run migrations
pnpm migration:run

# Build and link packages
pnpm --filter @rdk/core build
pnpm --filter @rdk/adapter-filesystem build

# Test CLI (after global install or via pnpm link)
node packages/rdk-cli/dist/cli.js init

# Add to Claude Desktop (after rdk init)
# Add to ~/Library/Application Support/Claude/claude_desktop_config.json:
{
  "mcpServers": {
    "rdk": {
      "command": "node",
      "args": ["/path/to/rdk/packages/rdk-cli/dist/cli.js", "mcp:serve"]
    }
  }
}
```

---

## Environment Variables

### Central API (`.env`)
```
DATABASE_URL=postgresql://rdk:rdk@localhost:5432/rdk
REDIS_URL=redis://localhost:6379
JWT_SECRET=<32+ chars>
API_KEY_ENCRYPTION_KEY=<32 byte hex>
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
CENTRAL_API_URL=https://api.rdk.network
NODE_ENV=production
PORT=3000

# Stripe price IDs (populate from Stripe dashboard)
STRIPE_PRICE_STARTER_MONTHLY=price_xxx
STRIPE_PRICE_STARTER_YEARLY=price_xxx
STRIPE_PRICE_PRO_MONTHLY=price_xxx
STRIPE_PRICE_PRO_YEARLY=price_xxx
STRIPE_PRICE_ENTERPRISE_MONTHLY=price_xxx
STRIPE_PRICE_ENTERPRISE_YEARLY=price_xxx
```

### Node runtime (NOT stored in config)
```
RDK_WALLET_PRIVATE_KEY=0x...   # for x402 tip settlement — set at runtime only
RDK_API_URL=https://api.rdk.network  # override central API URL
BASE_RPC_URL=https://mainnet.base.org
ETH_RPC_URL=https://cloudflare-eth.com
POLYGON_RPC_URL=https://polygon-rpc.com
```

---

## Open Questions (from spec)

1. **Embedding model**: MiniLM-L6-v2 (384-dim, 23MB) vs mpnet-base-v2 (768-dim, 420MB). Current: MiniLM. Benchmark retrieval quality before deciding.

2. **pgvector index**: IVFFlat currently. Migrate to HNSW when chunk count > 1M.

3. **NAT traversal for content delivery**: When central routes to a provider node to fetch chunk content, node must be reachable. Current approach (Option C): summaries are stored on central as fallback when node unreachable. This is already implemented — `NetworkChunk.summary` is used when `content` not available.

4. **Tip currency**: USDC on Base is primary. Solana USDC is CryptoCadet Pay's domain — could integrate via existing CryptoCadet Pay infrastructure rather than implementing directly in RDK.

5. **Cold start bootstrapping**: Run internal CryptoCadet nodes in key domains + sign 1-2 enterprise customers before public launch.

6. **Chunk dedup**: SHA256 of content is the `chunkHash`. On central, `ON CONFLICT (chunk_hash) DO UPDATE` means identical content from multiple nodes collapses. Quality score updates benefit all nodes sharing that hash — implement this in quality.service.ts.

---

## Naming / Domain

- CLI binary: `rdk`
- npm packages: `@rdk/core`, `@rdk/cli`, `@rdk/mcp`, `@rdk/x402`, `@rdk/adapter-*`
- Central API: `api.rdk.network`
- Dashboard: `app.rdk.network`
- Marketing: `rdk.network`
- GitHub: `github.com/cryptocadet/rdk`

---

## Key Files Quick Reference

| File | Purpose |
|------|---------|
| `packages/rdk-core/src/router.ts` | Query routing logic (private → network → fallback) |
| `packages/rdk-core/src/store/local-store.ts` | SQLite store + cosine similarity search |
| `packages/rdk-core/src/indexer.ts` | clean → chunk → embed → categorize → store → sync |
| `packages/rdk-core/src/models/embedding.ts` | @xenova/transformers wrapper |
| `packages/rdk-mcp/src/server.ts` | MCP tool registration |
| `packages/rdk-mcp/src/node.ts` | Tool handler implementations |
| `packages/rdk-cli/src/cli.ts` | Commander command registry |
| `packages/rdk-cli/src/commands/init.ts` | `rdk init` wizard |
| `packages/rdk-x402/src/client.ts` | On-chain USDC tip settlement |
| `apps/central-api/src/chunks/chunks.service.ts` | pgvector upsert + quality scoring |
| `apps/central-api/src/query/query.service.ts` | pgvector ANN search |
| `apps/central-api/src/migrations/001_initial_schema.ts` | Full DB schema |

---

## On-Demand Dependency Architecture (added post-scaffold)

### Install Tiers

| Tier | Trigger | Packages installed | Size |
|------|---------|-------------------|------|
| 1 | `pnpm install` | commander, chalk, ora, inquirer, open, better-sqlite3, glob, gray-matter | ~10MB |
| 2 | `rdk vault:connect <adapter>` | `@rdk/adapter-obsidian` or `@rdk/adapter-filesystem` etc. | ~1MB |
| 3 | `rdk network:join` | `@xenova/transformers`, `@modelcontextprotocol/sdk` | ~50MB |
| 4 | `rdk tips:enable` | `ethers` | ~15MB |

### Key files
- `packages/rdk-cli/src/require-dep.ts` — `requireDep()` and `requireDeps()` utilities
- `packages/rdk-cli/src/commands/tips.ts` — new Tier 4 command
- All commands gate their heavy deps with `requireDep()` before proceeding

### User flow
```
npm install -g rdk          # Tier 1 — 15 seconds
rdk init                    # wizard, installs Tier 2 + 3 on confirm
rdk status                  # shows what's installed vs missing
rdk network:join            # explicit Tier 3 if skipped during init
rdk tips:enable             # explicit Tier 4
```

### requireDep behaviour
- Tries `import(packageName)` — if it works, returns true immediately (zero overhead on subsequent calls)
- If missing: shows package name, size, reason, asks Y/n
- Runs `npm install <package>` in cwd on confirm
- Non-TTY (piped/scripted): defaults to Y automatically
