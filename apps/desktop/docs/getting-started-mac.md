# RDK Desktop — Getting Started (macOS)

A desktop app for your RDK node: an Obsidian-style three-pane file explorer plus a
force-directed graph of your knowledge **and what the network actually retrieved from
it**. It reads and writes the same `~/.rdk` config and index as the `rdk` CLI — the
two are interchangeable.

Read these three things first — they'll save you confusion:

- **Download it from CI.** The `Desktop Release` workflow (Actions → Run workflow, or a
  `desktop-v*` tag) produces a `.dmg` + `.zip`. That's the easiest path — §2 Option C.
  Building from source still works and is best for active development.
- **CI builds Apple Silicon (arm64) only.** The mac runner is `macos-latest` = arm64.
  On an **Intel** Mac, a CI `.dmg` won't run — build from source instead.
- **Unsigned until signing is set up.** Until the Developer ID secrets are added (see
  [signing.md](signing.md)), builds are **unsigned** and macOS Gatekeeper will refuse
  them with *"RDK is damaged"* or *"unidentified developer."* §5 has the workaround
  for testing; the real fix is notarization.

---

## 1. Prerequisites

- **macOS** 12+ (Apple Silicon or Intel)
- **Node 20+** (22 recommended) and **pnpm**
- **Xcode Command Line Tools** — `xcode-select --install` (needed to rebuild the
  native SQLite module)
- A **git checkout** of this repo, ~3 GB free disk for a build

You do **not** need `@retrodeck/rdk` installed globally — the app bundles everything,
including its own Electron. If you already use the CLI, the app picks up your existing
account and vault automatically.

```bash
git clone git@github.com:thetechjd/rdk.git
cd rdk
pnpm install
pnpm --filter @rdk/core --filter @rdk/node build   # the libs the app imports
```

---

## 2. Run it

### Option A — dev mode (best for testing; hot reload + devtools)

```bash
cd apps/desktop
pnpm run rebuild     # rebuild better-sqlite3 against Electron's ABI — do this once
pnpm dev
```

`pnpm run rebuild` is the step people skip. Without it the app dies on first database
access with a `NODE_MODULE_VERSION` mismatch — Electron's Node ABI differs from your
system Node's.

### Option B — a real .app / .dmg

```bash
# from the repo root
RDK_DEPLOY_DIR=~/rdk-build bash apps/desktop/scripts/package.sh --mac
```

Artifacts land in `~/rdk-build/release/`:

- `RDK-0.1.0-arm64.dmg` — the installer (drag RDK into Applications)
- `RDK-0.1.0-arm64-mac.zip` — the zipped `.app` (used by auto-update)

It builds for **your** Mac's architecture (arm64 on Apple Silicon, x64 on Intel). Set
`RDK_DEPLOY_DIR` somewhere with room — it defaults into a temp dir.

> Use the script — don't call `electron-builder` directly. pnpm and electron-builder
> disagree about workspace symlinks, and `pnpm exec` prunes devDependencies mid-build.
> `package.sh` handles all of that.

Then open the `.dmg` and drag **RDK** into **Applications**. See §5 if Gatekeeper
blocks it (it will, until the build is signed + notarized).

### Option C — grab a CI build instead

Actions → **Desktop Release** → **Run workflow** on `main`, then download the
**`rdk-desktop-macos-latest`** artifact (a `.dmg` + `.zip`).

⚠️ It's **arm64** (Apple Silicon) and **unsigned**. On Intel, build from source. On
Apple Silicon, you'll still hit Gatekeeper — see §5.

---

## 3. First run

A five-step wizard:

1. **Sign in** — email + password, in-app. No browser round-trip, no token pasting.
   *create account →* opens web signup. You can skip and run local-only, then sign in
   later from **Settings → Account**.
2. **Choose your vault** — your notes folder; an Obsidian vault works as-is.
3. **Plan & default visibility** — `private` or `public` for new indexing.
4. **Start node** (+ optional auto-start).
5. **MCP snippet** for Claude Desktop — optional, also in Settings → MCP.

Signing in here writes tokens to `~/.rdk/config.json`, so it re-authenticates the CLI
too, and vice versa.

---

## 4. The mental model: LOCAL / PRIVATE / PUBLIC

Internalise this first — every file in the tree carries its state as a dot, and the
whole UI is built around the distinction:

| Dot | State | Meaning |
|---|---|---|
| ◯ grey | **local** | A file on your machine. Not indexed, not on the network. |
| ● dim | **private** | Indexed and **encrypted** (AES-256-GCM) on the network. Only you and team members holding your vault key can read it. RetroDeck can't. |
| ● bright | **public** | Indexed as **plaintext** on the network. Anyone can read it; earns USDC tips when retrieved. **Immutable.** |

Indexing always asks which you want, and **cancel keeps it local**. Public is one-way:
no unpublish, no public → private. That's by design, not a missing feature.

---

## 5. Gatekeeper: opening an unsigned build

Until the app is signed + notarized (tracked in [signing.md](signing.md)), macOS will
block a locally-built or downloaded `.app`. For **your own testing**, clear the
quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/RDK.app
open /Applications/RDK.app
```

Or: right-click **RDK.app** → **Open** → **Open** in the dialog (works for
*"unidentified developer"*, but not the *"damaged"* variant — use the `xattr` command
for that).

**Do not ship a build to other people this way.** On someone else's Mac an unsigned
app is untrustworthy and increasingly hard to open. The correct fix is a signed,
notarized build — add the five secrets in [signing.md](signing.md) and the CI release
becomes double-clickable with no warning.

---

## 6. What to exercise

**Vault**
- [ ] Tree lists your files with correct state dots and counts
- [ ] **`+ note`** in the header, and folder right-click → **new note here**
- [ ] **Edit** a file → `⌘S` → writes to disk; if indexed, toast reports re-indexed chunks
- [ ] **Drag a file from the tree** onto the drop zone → private/public dialog → indexes
- [ ] **Drag in from Finder** → same dialog
- [ ] **Right-click a file** → index private / index public / reveal / remove from index
- [ ] **Vault name `▾`** → open vault folder / change vault / re-index

**Graph** — the reason the app exists
- [ ] File nodes appear, sized by retrieval count, coloured by state
- [ ] Semantic edges link related notes
- [ ] Run a few queries → **retrieval edges + query nodes** appear (query → chunk)
- [ ] Click a node → loads it in the inspector

**Query & content**
- [ ] `⌘K` → query → results show source node + similarity
- [ ] Click a file → renders markdown; private content decrypts locally

**Inspector**
- [ ] State, chunk count, retrievals, size
- [ ] **RETRIEVED FOR** lists the queries that actually hit this file
- [ ] `publish` promotes a private chunk to public

**Settings**
- [ ] **Node** — start/stop, force sync, status
- [ ] **Account** — sign in/out, plan picker (live plans, monthly/yearly), **top up**
- [ ] **Vault** — change directory, re-index
- [ ] **MCP** — copyable Claude Desktop snippet
- [ ] **Earnings** — tips, per-chunk breakdown

---

## 7. Known gaps — please don't file these

- **unpublish** and **pin** appear but are disabled — public chunks are immutable by
  design; pinning has no backend.
- **Crypto top-up is CLI-only.** It drives an interactive `cryptocadet` binary a
  packaged app can't host. In-app top-up opens a web checkout that takes **card or
  crypto**, so nothing is actually blocked.
- **Not in the UI yet** — use the CLI: `team:*`, `apikey:rotate`, `wallet <addr>`,
  `tips:enable`, `vault:rotate-key`, `service:install`, `mcp validate/test`,
  `account:relink`, bulk `vault:publish`.
- **The content pane is deliberately not a full editor.** Obsidian is still the
  editor; in-app editing is intentionally minimal.
- **Auto-start** on macOS registers a Login Item.

---

## 8. Troubleshooting

**"RDK is damaged and can't be opened" / "unidentified developer"** → the build is
unsigned. `xattr -dr com.apple.quarantine /Applications/RDK.app` for testing (§5); the
real fix is notarization ([signing.md](signing.md)).

**"Embedding model unavailable"** → the first index/query downloads a ~23 MB model to
`~/.rdk/models`; that needs network access. Otherwise make sure you're on a build from
commit `12d7d24` or later — earlier builds had a packaging bug that stripped the model
runtime out.

**`NODE_MODULE_VERSION` mismatch** → `pnpm run rebuild` in `apps/desktop`. If it fails,
you're probably missing the Xcode CLT — `xcode-select --install`.

**`Exec format error` / app won't launch on Intel** → the build is arm64. Build from
source on your Intel Mac.

**Blank balance/plan, or "session expired"** → **Settings → Account** → sign in.

**Where state lives**

```
~/.rdk/config.json   node identity, account tokens, vault path   (shared with the CLI)
~/.rdk/index.db      local chunk + embedding cache
~/.rdk/models/       embedding model weights (~23MB)
```

**Starting clean:** deleting `~/.rdk` also destroys your **node identity and vault
key** — anything already encrypted as private becomes permanently unreadable. Back it
up first. Prefer Settings → change vault / re-index.

**Logs:** launch from a terminal to see stderr:
`/Applications/RDK.app/Contents/MacOS/RDK`. In `pnpm dev` you get renderer devtools.

---

## 9. Reporting a bug

Include:

- How you built/ran it (`pnpm dev` vs `package.sh` vs CI artifact) and the commit SHA
- Mac model + chip (Apple Silicon vs Intel), macOS version
- Terminal output — launch from a terminal so stderr is visible
- Whether you're signed in, and whether the node shows as serving in the status bar
```
