# RDK install script for Windows
# Usage: irm https://rdk.network/install.ps1 | iex
#
# Override install dir: $env:RDK_INSTALL_DIR = "C:\tools"; irm ... | iex

$ErrorActionPreference = 'Stop'

$Version    = "1.0.0"
$Repo       = "thetechjd/rdk"
$Binary     = "rdk-win-x64.exe"
$Tarball    = "rdk-win-x64.exe.tar.gz"
$BaseUrl    = "https://github.com/$Repo/releases/download/v$Version"
$InstallDir = if ($env:RDK_INSTALL_DIR) { $env:RDK_INSTALL_DIR } else { "$env:LOCALAPPDATA\Programs\rdk" }

# ── Download ──────────────────────────────────────────────────────────────────
$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $TmpDir | Out-Null

try {
    Write-Host "Downloading rdk v$Version..."
    $TarPath = Join-Path $TmpDir $Tarball
    Invoke-WebRequest -Uri "$BaseUrl/$Tarball" -OutFile $TarPath -UseBasicParsing

    # ── Verify SHA256 (optional) ──────────────────────────────────────────────
    try {
        $SumsPath = Join-Path $TmpDir "SHA256SUMS"
        Invoke-WebRequest -Uri "$BaseUrl/SHA256SUMS" -OutFile $SumsPath -UseBasicParsing
        $Expected = (Get-Content $SumsPath | Where-Object { $_ -match [regex]::Escape($Tarball) }) -split '\s+' | Select-Object -First 1
        if ($Expected) {
            $Actual = (Get-FileHash $TarPath -Algorithm SHA256).Hash.ToLower()
            if ($Actual -ne $Expected) {
                throw "SHA256 mismatch! Expected: $Expected, got: $Actual"
            }
            Write-Host "SHA256 verified."
        }
    } catch [System.Net.WebException] {
        # SHA256SUMS not available — skip verification
    }

    # ── Extract ───────────────────────────────────────────────────────────────
    tar -xzf $TarPath -C $TmpDir

    # ── Install ───────────────────────────────────────────────────────────────
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $Dest = Join-Path $InstallDir "rdk.exe"
    Copy-Item (Join-Path $TmpDir $Binary) $Dest -Force

    # ── Add to PATH (user scope) ──────────────────────────────────────────────
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($UserPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
        Write-Host "Added $InstallDir to your PATH."
        Write-Host "(Restart your terminal for PATH changes to take effect.)"
    }

    Write-Host ""
    Write-Host "rdk v$Version installed to $Dest"
    Write-Host ""
    Write-Host "Get started:"
    Write-Host "  rdk init"
    Write-Host ""
    Write-Host "Docs: https://rdk.network/docs"

} finally {
    Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
