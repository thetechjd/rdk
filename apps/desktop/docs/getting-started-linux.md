# RDK Desktop — Getting Started (Linux)

A desktop app for your RDK node: an Obsidian-style three-pane file explorer plus a
force-directed graph of your knowledge **and what the network actually retrieved
from it**. It reads and writes the same `~/.rdk` config and index as the `rdk` CLI —
the two are interchangeable.

Two things worth knowing before you start:

- **There is no download yet.** The `Desktop Release` workflow only runs on manual
  dispatch or a `desktop-v*` tag, and neither has happened — so no CI artifact
  exists. Build it from source (below). It takes a few minutes.
- **A build is a frozen snapshot.** `git pull` does not update an installed
  AppImage — you rebuild. And you can't overwrite the AppImage while it's running
  (`Text file busy`); close the app first.

---

## 1. Prerequisites

- **Node 20+** (22 recommended) and **pnpm**
- A **git checkout** of this repo
- Linux, any arch — you build for whatever CPU you're on (x86_64, arm64, …)
- ~3 GB free disk for the build

You do **not** need `@retrodeck/rdk` installed globally. The app bundles everything,
including its own Electron. If you *do* have the CLI configured, the app picks up
your existing account and vault automatically.

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
pnpm run rebuild     # rebuilds better-sqlite3 against Electron's ABI — do this once
pnpm dev
```

`pnpm run rebuild` is the step people skip. Without it the app dies on first database
access with a `NODE_MODULE_VERSION` mismatch — Electron's Node ABI differs from your
system Node's.

### Option B — a real installable build

```bash
# from the repo root
RDK_DEPLOY_DIR=~/rdk-build bash apps/desktop/scripts/package.sh --linux
```

Artifacts land in `~/rdk-build/release/`:

- `RDK-0.1.0-<arch>.AppImage` — portable, no install
- `rdk-desktop_0.1.0_<arch>.deb` — system install

Set `RDK_DEPLOY_DIR` somewhere with room. It defaults into `/tmp`, which on many
distros is a small tmpfs that the build will fill.

> Use the script — don't call `electron-builder` directly. pnpm and electron-builder
> disagree about workspace symlinks, and `pnpm exec` prunes devDependencies mid-build.
> `package.sh` handles all of that.

**Run the AppImage:**

```bash
chmod +x ~/rdk-build/release/RDK-*.AppImage
~/rdk-build/release/RDK-*.AppImage
```

On Ubuntu 24.04+ there's no libfuse2, so either:

```bash
./RDK-*.AppImage --appimage-extract-and-run    # no FUSE needed
# or: sudo apt install libfuse2
```

**Or install the .deb:**

```bash
sudo apt install ~/rdk-build/release/rdk-desktop_*.deb
```

Launch **RDK** from your app menu or run `rdk-desktop`. Remove with
`sudo apt remove rdk-desktop`.

### Option C — grab a CI build instead

If you'd rather not build: **Actions → Desktop Release → Run workflow** on `main`,
then download the **`rdk-desktop-ubuntu-latest`** artifact (AppImage + deb).

⚠️ CI only builds **x86_64**. On an arm64 box the artifact won't start
(`Exec format error`) — build from source instead.

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

## 5. What to exercise

**Vault**
- [ ] Tree lists your files with correct state dots and counts
- [ ] **`+ note`** in the header, and folder right-click → **new note here**
- [ ] **Edit** a file → `⌘/Ctrl+S` → writes to disk; if indexed, toast reports re-indexed chunks
- [ ] **Drag a file from the tree** onto the drop zone → private/public dialog → indexes
- [ ] **Drag in from your file manager** → same dialog
- [ ] **Right-click a file** → index private / index public / reveal / remove from index
- [ ] **Vault name `▾`** → open vault folder / change vault / re-index

**Graph** — the reason the app exists
- [ ] File nodes appear, sized by retrieval count, coloured by state
- [ ] Semantic edges link related notes
- [ ] Run a few queries → **retrieval edges + query nodes** appear (query → chunk)
- [ ] Click a node → loads it in the inspector

**Query & content**
- [ ] `⌘/Ctrl+K` → query → results show source node + similarity
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

## 6. Known gaps — please don't file these

- **unpublish** and **pin** appear but are disabled — public chunks are immutable by
  design; pinning has no backend.
- **Crypto top-up is CLI-only.** It drives an interactive `cryptocadet` binary a
  packaged app can't host. In-app top-up opens a web checkout that takes **card or
  crypto**, so nothing is actually blocked.
- **Not in the UI yet** — use the CLI: `team:*`, `apikey:rotate`, `wallet <addr>`,
  `tips:enable`, `vault:rotate-key`, `service:install`, `mcp validate/test`,
  `account:relink`, bulk `vault:publish`.
- **Auto-start** installs a systemd *user* service, not a desktop login item.
- **The content pane is deliberately not a full editor.** Obsidian is still the
  editor; in-app editing is intentionally minimal.
- **macOS/Windows aren't shipped.** Linux only for now.

---

## 7. Troubleshooting

**"Embedding model unavailable"**
The first index/query downloads a ~23 MB model to `~/.rdk/models` — that needs
network access. If you're offline or behind a proxy, it fails here. Otherwise make
sure you're on a build from commit `12d7d24` or later; earlier builds had a
packaging bug that stripped the model runtime out of the app.

**`NODE_MODULE_VERSION` mismatch** → `pnpm run rebuild` in `apps/desktop`.

**AppImage won't mount / FUSE error** → `--appimage-extract-and-run`, or `sudo apt install libfuse2`.

**`Exec format error`** → wrong CPU arch (an x86_64 CI artifact on arm64). Build from source.

**`Text file busy` replacing the AppImage** → the app is running. Close it first.

**Blank balance/plan, or "session expired"** → **Settings → Account** → sign in.

**Build fills the disk / fails in `/tmp`** → set `RDK_DEPLOY_DIR` to a real disk.

**`.deb` step fails but the AppImage built fine** → known on some arm64 setups
(`fpm` chokes under Asahi/FEX emulation). The AppImage is the artifact that matters;
`.deb` builds cleanly on x86_64. Nothing else is wrong.

**Where state lives**

```
~/.rdk/config.json   node identity, account tokens, vault path   (shared with the CLI)
~/.rdk/index.db      local chunk + embedding cache
~/.rdk/models/       embedding model weights (~23MB)
```

**Starting clean:** deleting `~/.rdk` also destroys your **node identity and vault
key** — anything already encrypted as private becomes permanently unreadable. Back it
up first. Prefer Settings → change vault / re-index.

**Logs:** launch from a terminal to see stderr. In `pnpm dev` you get renderer devtools.

---

## 8. Reporting a bug

Include:

- How you built/ran it (`pnpm dev` vs `package.sh` vs CI artifact) and the commit SHA
- Distro + `uname -m`
- Terminal output — launch from a terminal so stderr is visible
- Whether you're signed in, and whether the node shows as serving in the status bar
</content>
