#!/usr/bin/env bash
# Writes tap/Formula/rdk.rb from env vars.
# Required: VERSION BASE_URL MAC_ARM_SHA MAC_X64_SHA LNX_X64_SHA LNX_ARM_SHA
# Usage: bash .github/scripts/write-formula.sh tap/Formula/rdk.rb
set -euo pipefail

OUT="${1:?output path required}"
mkdir -p "$(dirname "$OUT")"

cat > "$OUT" <<FORMULA
class Rdk < Formula
  desc "Retrieval Development Kit — distributed knowledge infrastructure"
  homepage "https://rdk.network"
  version "${VERSION}"
  license "MIT"

  on_macos do
    on_arm do
      url "${BASE_URL}/rdk-macos-arm64.tar.gz"
      sha256 "${MAC_ARM_SHA}"
    end
    on_intel do
      url "${BASE_URL}/rdk-macos-x64.tar.gz"
      sha256 "${MAC_X64_SHA}"
    end
  end

  on_linux do
    on_arm do
      url "${BASE_URL}/rdk-linux-arm64.tar.gz"
      sha256 "${LNX_ARM_SHA}"
    end
    on_intel do
      url "${BASE_URL}/rdk-linux-x64.tar.gz"
      sha256 "${LNX_X64_SHA}"
    end
  end

  def install
    bin.install "rdk-#{OS.mac? ? 'macos' : 'linux'}-#{Hardware::CPU.arm? ? 'arm64' : 'x64'}" => "rdk"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/rdk --version")
  end
end
FORMULA

echo "Wrote formula to $OUT"
