# RDK Desktop — Getting Started (Windows)

A desktop app for your RDK node: an Obsidian-style three-pane file explorer plus a
force-directed graph of your knowledge **and what the network actually retrieved from
it**. It reads and writes the same `.rdk` config and index as the `rdk` CLI — the two
are interchangeable.

Read these three things first — they'll save you confusion:

- **Download it from CI.** The `Desktop Release` workflow (Actions → Run workflow, or a
  `desktop-v*` tag) produces an NSIS `.exe` installer. That's the easiest path — §2
  Option C. Building from source still works and is best for active development.
- **CI builds x64 only.** The Windows runner is `windows-latest` = x64. On **Windows on
  ARM** an x64 `.exe` runs under emulation, but for a native build, build from source.
- **Unsigned until signing is set up.** Until the Azure Trusted Signing secrets are
  added (see [signing.md](signing.md)), builds are **unsigned** and Windows SmartScreen
  will flag them as from an *"unknown publisher."* §5 has the workaround for testing; the
  real fix is a signed build.

---

## 1. Prerequisites

- **Windows** 10 or 11 (x64; ARM works if you build from source)
- **Node 20+** (22 recommended) and **pnpm**
- **Git for Windows** — you'll run the build script under its bundled **Git Bash**
- **Visual Studio Build Tools** with *Desktop development with C++* (MSVC v143) **and
  Python 3** — only needed if `better-sqlite3` has no prebuilt for Electron's exact ABI
  and has to compile from source (§8)
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

### Option B — a real installer

Run the script from **Git Bash** (it's a bash script; PowerShell/cmd won't run it):

```bash
# from the repo root, in Git Bash
RDK_DEPLOY_DIR=~/rdk-build bash apps/desktop/scripts/package.sh --win
```

Artifacts land in `~/rdk-build/release/`:

- `RDK Setup 0.1.0.exe` — the NSIS installer

It builds for **your** machine's architecture (x64 on most PCs). Set `RDK_DEPLOY_DIR`
somewhere with room — it defaults into a temp dir.

> Use the script — don't call `electron-builder` directly. pnpm and electron-builder
> disagree about workspace symlinks, and `pnpm exec` prunes devDependencies mid-build.
> `package.sh` handles all of that.

Then double-click `RDK Setup 0.1.0.exe`. It's not a one-click installer, so you can pick
the install directory; it installs **per-user** (no admin prompt) to
`%LOCALAPPDATA%\Programs\rdk` and adds Start Menu + desktop shortcuts. See §5 if
SmartScreen blocks it (it will, until the build is signed).

### Option C — grab a CI build instead

Actions → **Desktop Release** → **Run workflow** on `main`, then download the
**`rdk-desktop-windows-latest`** artifact (the `.exe`).

⚠️ It's **x64** and **unsigned**. On Windows on ARM, build from source for a native
binary. Either way you'll hit SmartScreen — see §5.

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

Signing in here writes tokens to `%USERPROFILE%\.rdk\config.json`, so it
re-authenticates the CLI too, and vice versa.

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

## 5. SmartScreen: opening an unsigned build

Until the app is signed (tracked in [signing.md](signing.md)), Windows Defender
SmartScreen will interrupt a locally-built or downloaded `.exe` with *"Windows protected
your PC"* and an *"unknown publisher"* note. For **your own testing**:

Click **More info** → **Run anyway**.

**Do not ship a build to other people this way.** On someone else's machine an unsigned
installer looks untrustworthy, and SmartScreen's warning gets scarier the fewer people
have run it. The correct fix is a signed build — add the Azure Trusted Signing secrets
in [signing.md](signing.md) and the CI release installs with your publisher name and no
warning.

---

## 6. What to exercise

**Vault**
- [ ] Tree lists your files with correct state dots and counts
- [ ] **`+ note`** in the header, and folder right-click → **new note here**
- [ ] **Edit** a file → `Ctrl+S` → writes to disk; if indexed, toast reports re-indexed chunks
- [ ] **Drag a file from the tree** onto the drop zone → private/public dialog → indexes
- [ ] **Drag in from File Explorer** → same dialog
- [ ] **Right-click a file** → index private / index public / reveal / remove from index
- [ ] **Vault name `▾`** → open vault folder / change vault / re-index

**Graph** — the reason the app exists
- [ ] File nodes appear, sized by retrieval count, coloured by state
- [ ] Semantic edges link related notes
- [ ] Run a few queries → **retrieval edges + query nodes** appear (query → chunk)
- [ ] Click a node → loads it in the inspector

**Query & content**
- [ ] `Ctrl+K` → query → results show source node + similarity
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
- **Auto-start** registers a Windows startup login item (Electron `setLoginItemSettings`).
  The CLI's `service:install` instead creates a Task Scheduler task `RetroDeck-RDK` with
  a logon trigger, for headless serving before you sign in.
- **`~/.rdk` isn't ACL-locked on Windows.** The `0600`/`0700` file modes the CLI sets
  are no-ops here, so `config.json` (which holds your account tokens and EVM key) inherits
  your user-profile ACLs rather than being tightened. Keep your Windows account private.
- **The content pane is deliberately not a full editor.** Obsidian is still the
  editor; in-app editing is intentionally minimal.

---

## 8. Troubleshooting

**"Windows protected your PC" / "unknown publisher"** → the build is unsigned. **More
info → Run anyway** for testing (§5); the real fix is Azure Trusted Signing
([signing.md](signing.md)).

**"Embedding model unavailable"** → the first index/query downloads a ~23 MB model to
`%USERPROFILE%\.rdk\models`; that needs network access. Otherwise make sure you're on a
build from commit `12d7d24` or later — earlier builds had a packaging bug that stripped
the model runtime out.

**`NODE_MODULE_VERSION` mismatch** → `pnpm run rebuild` in `apps/desktop`. If the rebuild
fails to *compile*, `better-sqlite3` had no prebuilt for this Electron ABI and needs a
toolchain: install **Visual Studio Build Tools** (*Desktop development with C++*, MSVC
v143) **and Python 3**, reopen your shell, and re-run.

**App won't launch / crashes on Windows on ARM** → the CI `.exe` is x64 and runs under
emulation. For a native binary, build from source on the ARM machine.

**Blank balance/plan, or "session expired"** → **Settings → Account** → sign in.

**Can't overwrite the app while it's running** → close RDK first; Windows locks a running
`.exe`. The installer handles this when you upgrade.

**Where state lives**

```
%USERPROFILE%\.rdk\config.json   node identity, account tokens, vault path   (shared with the CLI)
%USERPROFILE%\.rdk\index.db      local chunk + embedding cache
%USERPROFILE%\.rdk\models\       embedding model weights (~23MB)
```

(That's `C:\Users\<you>\.rdk`.)

**Starting clean:** deleting `%USERPROFILE%\.rdk` also destroys your **node identity and
vault key** — anything already encrypted as private becomes permanently unreadable. Back
it up first. Prefer Settings → change vault / re-index.

**Logs:** launch from a terminal to see stderr —
`& "$env:LOCALAPPDATA\Programs\rdk\RDK.exe"` in PowerShell. In `pnpm dev` you get
renderer devtools.

---

## 9. Reporting a bug

Include:

- How you built/ran it (`pnpm dev` vs `package.sh` vs CI artifact) and the commit SHA
- Windows version + build, and arch (x64 vs ARM)
- Terminal output — launch from a terminal so stderr is visible
- Whether you're signed in, and whether the node shows as serving in the status bar
