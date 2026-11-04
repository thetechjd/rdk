# Private RDK node hosts

`cocoa-host.mjs` runs one private, encrypted RDK node per tenant (its own process, vault, config key and SQLite store) and publishes the tenant's approved knowledge into it. It serves exactly one publisher, set by `RDK_HOST_PUBLISHER`:

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
# COCOA_RDK_HOST_BIND=127.0.0.1  COCOA_MAX_NODES=16
```

The variable names are shared with Cocoa's host; only the values differ. Expose the port to Koryo's API and worker only, over loopback or a private network.
