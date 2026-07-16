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
CI=true pnpm --filter rdk-desktop deploy --prod --legacy "$DEPLOY"

cd "$APP_DIR"
ELECTRON_VER="$(node -p "require('electron/package.json').version")"
EB="$(node -e 'const p=require.resolve("electron-builder/package.json");const d=require("path").dirname(p);const b=require(p).bin;console.log(require("path").join(d, typeof b==="string"?b:b["electron-builder"]))')"
ER="$(node -e 'const p=require.resolve("@electron/rebuild/package.json");const d=require("path").dirname(p);const b=require(p).bin;console.log(require("path").join(d, typeof b==="string"?b:b["electron-rebuild"]))')"

echo "→ rebuilding better-sqlite3 for Electron $ELECTRON_VER"
node "$ER" --version "$ELECTRON_VER" --module-dir "$DEPLOY" --only better-sqlite3 --force

echo "→ electron-builder ${TARGET:-(current OS)}"
CI=true node "$EB" $TARGET \
  --projectDir "$DEPLOY" \
  --config "$DEPLOY/electron-builder.yml" \
  -c.electronVersion="$ELECTRON_VER" \
  -c.npmRebuild=false

echo "→ installers in $DEPLOY/release:"
ls -1 "$DEPLOY/release" | grep -E '\.(AppImage|deb|dmg|zip)$' || echo "  (none matched — check electron-builder output above)"
