class Rdk < Formula
  desc "Retrieval Development Kit — distributed knowledge infrastructure"
  homepage "https://rdk.network"
  version "1.0.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/thetechjd/rdk/releases/download/v1.0.0/rdk-macos-arm64.tar.gz"
      sha256 "PLACEHOLDER_MAC_ARM64_SHA256"
    end
    on_intel do
      url "https://github.com/thetechjd/rdk/releases/download/v1.0.0/rdk-macos-x64.tar.gz"
      sha256 "PLACEHOLDER_MAC_X64_SHA256"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/thetechjd/rdk/releases/download/v1.0.0/rdk-linux-arm64.tar.gz"
      sha256 "PLACEHOLDER_LINUX_ARM64_SHA256"
    end
    on_intel do
      url "https://github.com/thetechjd/rdk/releases/download/v1.0.0/rdk-linux-x64.tar.gz"
      sha256 "PLACEHOLDER_LINUX_X64_SHA256"
    end
  end

  def install
    binary = "rdk-#{OS.mac? ? 'macos' : 'linux'}-#{Hardware::CPU.arm? ? 'arm64' : 'x64'}"
    bin.install binary => "rdk"
    bin.install "better_sqlite3.node"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/rdk --version")
  end
end
