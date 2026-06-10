#!/usr/bin/env bash
# RDK install script — self-contained, no system Node required.
#
# Downloads a private Node runtime into ~/.rdk/runtime, installs @retrodeck/rdk
# via that runtime's npm (so better-sqlite3 compiles/prebuilds against a matching
# Node ABI), and places a wrapper on your PATH that always runs under it.
#
# Usage: curl -fsSL https://rdk.network/install.sh | bash
set -euo pipefail

NODE_VERSION="v22.12.0"            # pinned LTS — has better-sqlite3 prebuilds
NPM_PKG="@retrodeck/rdk@latest"
RDK_DIR="${HOME}/.rdk"
RUNTIME_DIR="${RDK_DIR}/runtime"
PREFIX_DIR="${RDK_DIR}/prefix"
INSTALL_DIR="${RDK_INSTALL_DIR:-/usr/local/bin}"

# ── Detect platform ──────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}" in
  Darwin) NODE_OS="darwin" ;;
  Linux)  NODE_OS="linux" ;;
  *) echo "Unsupported OS: ${OS}. Install via npm: npm i -g @retrodeck/rdk" >&2; exit 1 ;;
esac

case "${ARCH}" in
  arm64|aarch64) NODE_ARCH="arm64" ;;
  x86_64|amd64)  NODE_ARCH="x64" ;;
  *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;;
esac

NODE_PKG="node-${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_PKG}.tar.gz"

# ── Helpers ──────────────────────────────────────────────────────────────────
fetch() {
  # fetch <url> <output>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    echo "Error: curl or wget is required" >&2; exit 1
  fi
}

# ── Download + extract Node runtime ──────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "Installing RDK (bundling Node ${NODE_VERSION} for ${NODE_OS}-${NODE_ARCH})..."
echo "  Downloading Node runtime..."
fetch "${NODE_URL}" "${TMP}/node.tar.gz"

# Verify the Node tarball against the official checksums (best-effort)
if fetch "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" "${TMP}/SHASUMS256.txt" 2>/dev/null; then
  EXPECTED=$(grep "${NODE_PKG}.tar.gz" "${TMP}/SHASUMS256.txt" | awk '{print $1}')
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL=$(sha256sum "${TMP}/node.tar.gz" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL=$(shasum -a 256 "${TMP}/node.tar.gz" | awk '{print $1}')
  fi
  if [ -n "${EXPECTED:-}" ] && [ -n "${ACTUAL:-}" ] && [ "${EXPECTED}" != "${ACTUAL}" ]; then
    echo "Node checksum mismatch — aborting." >&2; exit 1
  fi
fi

rm -rf "${RUNTIME_DIR}"
mkdir -p "${RUNTIME_DIR}"
tar -xzf "${TMP}/node.tar.gz" -C "${RUNTIME_DIR}" --strip-components=1

NODE_BIN="${RUNTIME_DIR}/bin/node"
NPM_CLI="${RUNTIME_DIR}/lib/node_modules/npm/bin/npm-cli.js"

# ── Install @retrodeck/rdk with the bundled runtime ──────────────────────────
echo "  Installing ${NPM_PKG} (compiling native modules)..."
rm -rf "${PREFIX_DIR}"
mkdir -p "${PREFIX_DIR}"
# Put the bundled node first on PATH so node-gyp/prebuild-install use it.
PATH="${RUNTIME_DIR}/bin:${PATH}" "${NODE_BIN}" "${NPM_CLI}" install \
  --global --prefix="${PREFIX_DIR}" --loglevel=error "${NPM_PKG}"

CLI_JS="${PREFIX_DIR}/lib/node_modules/@retrodeck/rdk/dist/cli.js"
if [ ! -f "${CLI_JS}" ]; then
  echo "Install failed: ${CLI_JS} not found" >&2; exit 1
fi

# ── Write the wrapper onto PATH ──────────────────────────────────────────────
NEED_SUDO=""
if [ ! -w "${INSTALL_DIR}" ]; then NEED_SUDO="sudo"; fi

WRAPPER="${TMP}/rdk"
cat > "${WRAPPER}" <<WRAP
#!/bin/sh
# RDK wrapper — runs the CLI under the bundled Node runtime.
export PATH="${RUNTIME_DIR}/bin:\$PATH"
exec "${NODE_BIN}" "${CLI_JS}" "\$@"
WRAP
chmod 755 "${WRAPPER}"
${NEED_SUDO} install -m 755 "${WRAPPER}" "${INSTALL_DIR}/rdk"

echo ""
echo "✓ rdk installed to ${INSTALL_DIR}/rdk"
"${INSTALL_DIR}/rdk" --version >/dev/null 2>&1 && echo "  version: $("${INSTALL_DIR}/rdk" --version)"
echo ""
echo "Get started:"
echo "  rdk init"
echo ""
echo "Docs: https://rdk.network/docs"
