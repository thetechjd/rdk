#!/usr/bin/env bash
# RDK install script
# Usage: curl -fsSL https://rdk.network/install.sh | bash
set -euo pipefail

VERSION="1.0.0"
REPO="thetechjd/rdk"
BASE_URL="https://github.com/${REPO}/releases/download/v${VERSION}"
INSTALL_DIR="${RDK_INSTALL_DIR:-/usr/local/bin}"

# ── Detect platform ──────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}" in
  Darwin)
    case "${ARCH}" in
      arm64) BINARY="rdk-macos-arm64" ;;
      x86_64) BINARY="rdk-macos-x64" ;;
      *) echo "Unsupported macOS architecture: ${ARCH}" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    case "${ARCH}" in
      aarch64|arm64) BINARY="rdk-linux-arm64" ;;
      x86_64) BINARY="rdk-linux-x64" ;;
      *) echo "Unsupported Linux architecture: ${ARCH}" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "Unsupported OS: ${OS}" >&2
    echo "Install manually from: https://github.com/${REPO}/releases" >&2
    exit 1
    ;;
esac

TARBALL="${BINARY}.tar.gz"
URL="${BASE_URL}/${TARBALL}"

# ── Download ─────────────────────────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "Downloading rdk v${VERSION} (${BINARY})..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --progress-bar "${URL}" -o "${TMP}/${TARBALL}"
elif command -v wget >/dev/null 2>&1; then
  wget -q --show-progress "${URL}" -O "${TMP}/${TARBALL}"
else
  echo "Error: curl or wget is required" >&2
  exit 1
fi

# ── Verify (optional, skip if SHA256SUMS not cached) ─────────────────────────
SHA_URL="${BASE_URL}/SHA256SUMS"
if curl -fsSL "${SHA_URL}" -o "${TMP}/SHA256SUMS" 2>/dev/null; then
  EXPECTED=$(grep "${TARBALL}" "${TMP}/SHA256SUMS" | awk '{print $1}')
  if [ -n "${EXPECTED}" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL=$(sha256sum "${TMP}/${TARBALL}" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
      ACTUAL=$(shasum -a 256 "${TMP}/${TARBALL}" | awk '{print $1}')
    fi
    if [ -n "${ACTUAL}" ] && [ "${ACTUAL}" != "${EXPECTED}" ]; then
      echo "SHA256 mismatch! Expected: ${EXPECTED}, got: ${ACTUAL}" >&2
      exit 1
    fi
  fi
fi

# ── Install ───────────────────────────────────────────────────────────────────
tar -xzf "${TMP}/${TARBALL}" -C "${TMP}"

NEED_SUDO=""
if [ ! -w "${INSTALL_DIR}" ]; then
  NEED_SUDO="sudo"
fi

${NEED_SUDO} install -m 755 "${TMP}/${BINARY}" "${INSTALL_DIR}/rdk"

echo ""
echo "✓ rdk v${VERSION} installed to ${INSTALL_DIR}/rdk"
echo ""
echo "Get started:"
echo "  rdk init"
echo ""
echo "Docs: https://rdk.network/docs"
