#!/usr/bin/env bash
# Build distributable installers for the RDK desktop app.
#
# Works around the pnpm + electron-builder friction: pnpm symlinks @rdk/core and
# @rdk/node to ../../packages/* (outside apps/desktop), which electron-builder
# can't asar-package. `pnpm deploy` materializes a self-contained app directory
# with those workspace deps as real folders; we rebuild the native module for
# Electron's ABI, then run electron-builder against that dir with npmRebuild off.
#
# The tool CLIs are invoked via `node` directly — NOT `pnpm exec`, which triggers
# a deps-status check that prunes devDependencies mid-run (removing the very tools
# we're about to call). See scripts note in .github/workflows/desktop-release.yml.
#
# Usage:  apps/desktop/scripts/package.sh [--mac|--linux|--win]
#         (default target = the current OS)
# Env:    RDK_DEPLOY_DIR  override the staging dir (default: $RUNNER_TEMP or /tmp)
set -euo pipefail

# pnpm runs a "deps status check" before `run`/`exec`/`--filter` commands that can
# fire an unwanted `pnpm install` (which, without a TTY, aborts or prunes devDeps
# mid-build). Disable it — the workspace is already installed by the caller/CI.
export npm_config_verify_deps_before_run=false

TARGET="${1:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APP_DIR="$REPO_ROOT/apps/desktop"
DEPLOY="${RDK_DEPLOY_DIR:-${RUNNER_TEMP:-/tmp}/rdk-desktop-deploy}"

cd "$REPO_ROOT"

# Bundle the embedding model into build/models BEFORE the deploy copies the app dir,
# so the packaged app ships it and embeds offline on first use (no HuggingFace fetch
# on the user's machine — the #1 "works on mine, not theirs" failure). Idempotent.
echo "→ bundling embedding model (build/models)"
bash "$APP_DIR/scripts/bundle-model.sh"

# Build with in-directory `npm run` rather than `pnpm --filter … build`: the latter
# runs pnpm's deps-status check which, in some environments, fires a production
# `pnpm install` that prunes devDependencies mid-build. In-dir npm run just executes
# the script against the already-installed node_modules.
echo "→ building @rdk/core + @rdk/node"
( cd "$REPO_ROOT/packages/rdk-core" && npm run build )
( cd "$REPO_ROOT/packages/rdk-node" && npm run build )

echo "→ building desktop (electron-vite → out/)"
( cd "$APP_DIR" && npm run build )

echo "→ pnpm deploy → $DEPLOY"
rm -rf "$DEPLOY"
# Never let a prior build's output dir get copied into the deploy (electron-builder
# writes to <deploy>/release; a stale apps/desktop/release would recurse into it).
rm -rf "$APP_DIR/release"
CI=true pnpm --filter rdk-desktop deploy --prod --legacy "$DEPLOY"

# pnpm deploy honors .gitignore, and build/models is gitignored (kept out of git,
# fetched at build time above). Copy it into the staged dir explicitly so
# electron-builder's `extraResources: from build/models` finds it. Without this the
# model is silently dropped and the packaged app falls back to a network download —
# the exact failure this bundling fixes.
mkdir -p "$DEPLOY/build"
cp -r "$APP_DIR/build/models" "$DEPLOY/build/"

cd "$APP_DIR"
ELECTRON_VER="$(node -p "require('electron/package.json').version")"
EB="$(node -e 'const p=require.resolve("electron-builder/package.json");const d=require("path").dirname(p);const b=require(p).bin;console.log(require("path").join(d, typeof b==="string"?b:b["electron-builder"]))')"
ER="$(node -e 'const p=require.resolve("@electron/rebuild/package.json");const d=require("path").dirname(p);const b=require(p).bin;console.log(require("path").join(d, typeof b==="string"?b:b["electron-rebuild"]))')"

echo "→ rebuilding better-sqlite3 for Electron $ELECTRON_VER"
node "$ER" --version "$ELECTRON_VER" --module-dir "$DEPLOY" --only better-sqlite3 --force

# Notarization stays OFF by default (electron-builder.yml has notarize:false) so
# unsigned local/CI builds keep working with no Apple credentials. The mac-release
# job sets RDK_MAC_NOTARIZE=true once signing+notary secrets are present, which
# flips it on via a CLI override — no per-run edit of the yml required.
# Signing/notarization overrides are appended per-platform only when the release job
# has the credentials (electron-builder.yml ships neither, so unsigned builds need no
# secrets). The mac job sets RDK_MAC_NOTARIZE; the win job sets RDK_WIN_AZURE_SIGN plus
# the (non-secret) Trusted Signing endpoint/account/profile — auth is via the
# AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET env that electron-builder reads.
EB_EXTRA=()
SIGNING=false
if [[ "${RDK_MAC_NOTARIZE:-}" == "true" ]]; then
  EB_EXTRA+=( -c.mac.notarize=true )
  SIGNING=true
fi
if [[ "${RDK_WIN_AZURE_SIGN:-}" == "true" ]]; then
  EB_EXTRA+=( -c.win.azureSignOptions.endpoint="$RDK_WIN_AZURE_ENDPOINT" )
  EB_EXTRA+=( -c.win.azureSignOptions.codeSigningAccountName="$RDK_WIN_AZURE_ACCOUNT" )
  EB_EXTRA+=( -c.win.azureSignOptions.certificateProfileName="$RDK_WIN_AZURE_PROFILE" )
  SIGNING=true
fi

run_electron_builder() {
  # ${EB_EXTRA[@]+"…"} guards empty-array expansion under `set -u` on bash 3.2 (macOS).
  CI=true node "$EB" $TARGET \
    --projectDir "$DEPLOY" \
    --config "$DEPLOY/electron-builder.yml" \
    -c.electronVersion="$ELECTRON_VER" \
    -c.npmRebuild=false \
    ${EB_EXTRA[@]+"${EB_EXTRA[@]}"}
}

echo "→ electron-builder ${TARGET:-(current OS)}$([[ "$SIGNING" == true ]] && echo ' (signing)')"
if [[ "$SIGNING" == true ]]; then
  # Notarization (Apple) and Trusted Signing (Azure) both call remote services that
  # intermittently drop the connection on hosted runners (e.g. NSURLErrorDomain -1009
  # "No network route") — a network blip, not a credential problem. Retry a few times.
  ATTEMPT=1; MAX=3
  until run_electron_builder; do
    if [ "$ATTEMPT" -ge "$MAX" ]; then
      echo "✗ electron-builder failed after $MAX attempts (see error above)."
      exit 1
    fi
    echo "→ sign/build attempt $ATTEMPT failed (possibly a transient signing-service network error); retrying in 30s…"
    ATTEMPT=$((ATTEMPT + 1))
    sleep 30
  done
else
  run_electron_builder
fi

echo "→ installers in $DEPLOY/release:"
ls -1 "$DEPLOY/release" | grep -E '\.(AppImage|deb|dmg|zip)$' || echo "  (none matched — check electron-builder output above)"
