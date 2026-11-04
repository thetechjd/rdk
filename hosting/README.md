# Private RDK node hosts

`cocoa-host.mjs` runs **one shared, private, encrypted RDK node** for every tenant it serves and publishes each tenant's approved knowledge into it. Tenants stay separate by ownership: RetroDeck records which account and project own each document (`support_documents`, `support_shared_bindings`) and checks it on every document, pin and unpin call, and each project has its own pin mode. The node stays online (answers fetch documents from it) and runs one operation at a time, queueing the rest. It registers on Central as the host itself, by service credential (`RDK_HOST_REGISTRATION_SECRET`, equal to Central's `SUPPORT_HOST_SECRET`), with no email.

`/ensure {scope, email}` returns the same `{nodeId, nodeApiKey, shared: true}` for every scope; publishers then bind each account and project with `{projectId, nodeApiKey, shared: true}` and claim each published document (`POST /:id/nodes/:nodeId/documents`). `RDK_HOST_SHARED=false` keeps the older mode, one node per scope (its own process and vault each), which does not scale and should not be used for new hosts.

It serves exactly one publisher, set by `RDK_HOST_PUBLISHER`:

| Publisher | Product | Unit | `/sync` credential | `/sync` id |
|---|---|---|---|---|
| `subzero` (default) | SubZero's Cocoa | `cocoa-host.service` | `sz_agent_` + 64 hex | project number |
| `koryo` | Koryo's Kaia | `kaia-host.service` | `kor_pub_` + 43 base64url (a publish-only credential) | workspace uuid |

Run a separate instance per publisher: its own OS user, secret, master key, data directory and capacity. Then one product's load can't use up the other's node slots, and one leaked secret reaches one product only. Both publishers speak the same protocol (`packages/rdk-node/src/support-sync.ts`) under `<publisher API>/agent-api/knowledge/:id`: `jobs`, then `claim`, private indexing and metadata sync, an optional `authorize-pin` and pin, then `complete` with the SHA-256 of the content, or `fail`.

## Kaia's host

Install the checkout at `/opt/rdk` (build `@rdk/core` and `@rdk/node`), create a `kaia` OS user, install `kaia-host.service`, and write `/etc/kaia/host.env`, readable only by that user:

```sh
RDK_HOST_PUBLISHER=koryo
COCOA_RDK_HOST_SECRET=...        # 32+ random characters; Koryo's KAIA_RDK_HOST_SECRET
COCOA_NODE_MASTER_KEY=...        # 64 hex; derives each node's config key. Not the same as Cocoa's
COCOA_PUBLIC_API_URL=https://api.koryo.app   # must equal Koryo's PUBLIC_URL exactly
RDK_CENTRAL_URL=https://rdk.retrodeck.ai
COCOA_NODE_DATA_DIR=/var/lib/kaia
COCOA_RDK_HOST_PORT=4251         # Cocoa's host keeps 4250
RDK_HOST_REGISTRATION_SECRET=...  # Central's SUPPORT_HOST_SECRET: registers the shared node, no email
# COCOA_RDK_HOST_BIND=127.0.0.1  RDK_HOST_MAX_QUEUED=200
```

The variable names are shared with Cocoa's host; only the values differ. Expose the port to Koryo's API and worker only, over loopback or a private network.
