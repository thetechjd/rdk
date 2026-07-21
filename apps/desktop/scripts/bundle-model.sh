#!/usr/bin/env bash
# Populate apps/desktop/build/models with the embedding model so packaged builds
# SHIP it and embed offline on first use — no HuggingFace fetch, no ~23MB download
# on the user's machine. electron-builder copies build/models → <app>/resources/models
# (see electron-builder.yml `extraResources`); the main process points
# RDK_MODELS_DIR at it and @rdk/core loads it locally with remote models disabled.
#
# Idempotent: skips if the model is already present. Prefers the local ~/.rdk cache
# (fast, offline) before reaching for the network.
#
# Usage: apps/desktop/scripts/bundle-model.sh   (called by package.sh; safe to run alone)
set -euo pipefail

MODEL="Xenova/all-MiniLM-L6-v2"
FILES=( "config.json" "tokenizer.json" "tokenizer_config.json" "onnx/model_quantized.onnx" )

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DEST="$REPO_ROOT/apps/desktop/build/models/$MODEL"

have_all() { local f; for f in "${FILES[@]}"; do [[ -f "$DEST/$f" ]] || return 1; done; }

if have_all; then
  echo "→ embedding model already bundled (build/models/$MODEL)"
  exit 0
fi

# Prefer the local cache the CLI/app populated on a prior run — offline and instant.
CACHE="$HOME/.rdk/models/$MODEL"
if [[ -f "$CACHE/onnx/model_quantized.onnx" ]]; then
  echo "→ copying embedding model from $CACHE"
  for f in "${FILES[@]}"; do
    mkdir -p "$(dirname "$DEST/$f")"
    cp "$CACHE/$f" "$DEST/$f"
  done
  if have_all; then echo "→ model bundled (from local cache)"; exit 0; fi
  echo "  cache was incomplete — falling back to download"
fi

echo "→ downloading embedding model from HuggingFace"
BASE="https://huggingface.co/$MODEL/resolve/main"
for f in "${FILES[@]}"; do
  echo "  · $f"
  mkdir -p "$(dirname "$DEST/$f")"
  curl -fsSL --retry 3 "$BASE/$f" -o "$DEST/$f"
done

have_all || { echo "✗ model bundle incomplete after download — check network/HuggingFace" >&2; exit 1; }
echo "→ model bundled (downloaded)"
