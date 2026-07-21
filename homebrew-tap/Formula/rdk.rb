# Homebrew formula for the RDK CLI — NODE-ENVIRONMENT build (no compiled binary).
#
# rdk is JavaScript, published to npm as @retrodeck/rdk. This formula depends on Node and
# installs the published npm package (+ production deps, incl. the prebuilt better-sqlite3)
# into libexec, then symlinks the `rdk` launcher — the SAME artifact `npm i -g @retrodeck/rdk`
# uses, so behavior is identical across macOS and Linux. This replaces the old per-arch
# pkg-compiled binary approach (GitHub-release tarballs, V8-bytecode-fragile).
#
# On each release bump the url's version segment and `sha256` — the SHA-256 of the tarball
# (NOT npm's `dist.shasum`, which is SHA-1):
#   curl -fsSL https://registry.npmjs.org/@retrodeck/rdk/-/rdk-<version>.tgz | shasum -a 256
class Rdk < Formula
  desc "Retrieval Development Kit — distributed knowledge infrastructure"
  homepage "https://rdk.network"
  url "https://registry.npmjs.org/@retrodeck/rdk/-/rdk-1.2.5.tgz"
  sha256 "cb30f369d3a640e94c80937c586903b206b0a890183a3a550fa8286f8a124e34"
  license "MIT"

  depends_on "node"

  def install
    # Installs the package + production deps (including the prebuilt native better-sqlite3)
    # into libexec, then links the bin. No build step — the published tarball ships dist/.
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/rdk --version")
  end
end
