#!/usr/bin/env bash
# Writes tap/Formula/rdk.rb as an npm-based formula.
# Homebrew installs @retrodeck/rdk via Node, compiling better-sqlite3 against
# the user's own Node runtime — guaranteeing a native-ABI match (no segfaults,
# unlike a standalone pkg binary that embeds its own Node).
#
# Required env: VERSION (bare semver, e.g. 1.0.4)
# Usage: bash .github/scripts/write-formula.sh tap/Formula/rdk.rb
set -euo pipefail

OUT="${1:?output path required}"
mkdir -p "$(dirname "$OUT")"

TARBALL_URL="https://registry.npmjs.org/@retrodeck/rdk/-/rdk-${VERSION}.tgz"

# The npm version must be published before this runs. Poll briefly for CDN propagation.
SHA=""
for attempt in 1 2 3 4 5 6; do
  if curl -fsSL "$TARBALL_URL" -o /tmp/rdk.tgz 2>/dev/null; then
    if command -v sha256sum >/dev/null 2>&1; then
      SHA=$(sha256sum /tmp/rdk.tgz | awk '{print $1}')
    else
      SHA=$(shasum -a 256 /tmp/rdk.tgz | awk '{print $1}')
    fi
    break
  fi
  echo "npm tarball not available yet (attempt $attempt) — waiting 15s..."
  sleep 15
done

if [[ -z "$SHA" ]]; then
  echo "ERROR: could not fetch $TARBALL_URL — publish @retrodeck/rdk@${VERSION} to npm before tagging the release." >&2
  exit 1
fi

cat > "$OUT" <<'FORMULA'
class Rdk < Formula
  desc "Retrieval Development Kit — distributed knowledge infrastructure"
  homepage "https://rdk.network"
  url "__TARBALL_URL__"
  sha256 "__SHA__"
  license "MIT"

  # Pin a stable Node that better-sqlite3 publishes prebuilt binaries for.
  # Homebrew's default "node" tracks bleeding-edge releases whose ABI often
  # has no matching prebuild, forcing a source build that fails in the sandbox.
  depends_on "node@22"

  def install
    node22 = Formula["node@22"]
    ENV.prepend_path "PATH", node22.opt_bin

    # Install by name from the registry (NOT the local dir — npm symlinks local
    # dirs and skips their deps). This installs the full dependency tree and runs
    # prebuild-install, downloading the better-sqlite3 binary for node@22's ABI.
    system node22.opt_bin/"npm", "install", "--global", "--prefix=#{libexec}", "@retrodeck/rdk@#{version}"

    # Wrap so `rdk` always runs under node@22 — same ABI the binary was fetched for.
    (bin/"rdk").write_env_script libexec/"bin/rdk", PATH: "#{node22.opt_bin}:$PATH"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/rdk --version")
  end
end
FORMULA

# Substitute values into the single-quoted heredoc (kept literal so Ruby's #{} survives)
sed -i.bak -e "s|__TARBALL_URL__|${TARBALL_URL}|" -e "s|__SHA__|${SHA}|" "$OUT" && rm -f "${OUT}.bak"

echo "Wrote npm-based formula to $OUT (version ${VERSION}, sha256 ${SHA})"
