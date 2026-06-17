# RDK install script for Windows
# Usage: irm https://rdk.network/install.ps1 | iex
#
# Installs @retrodeck/rdk globally via npm. Requires Node.js 20+.
# npm compiles/downloads the better-sqlite3 native module against your Node,
# so no prebuilt binary is bundled here.

$ErrorActionPreference = 'Stop'

# ── Require Node.js 20+ ───────────────────────────────────────────────────────
$node = Get-Command node -ErrorAction SilentlyContinue
$npm  = Get-Command npm  -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
    Write-Host ""
    Write-Host "Node.js is required but was not found on your PATH." -ForegroundColor Yellow
    Write-Host "Install Node.js 20 or newer from https://nodejs.org, then re-run this script."
    Write-Host ""
    exit 1
}

$nodeVersion = (& node --version) -replace '^v', ''
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
    Write-Host ""
    Write-Host "Node.js $nodeVersion found, but rdk requires Node.js 20 or newer." -ForegroundColor Yellow
    Write-Host "Upgrade from https://nodejs.org, then re-run this script."
    Write-Host ""
    exit 1
}

# ── Install ───────────────────────────────────────────────────────────────────
Write-Host "Installing @retrodeck/rdk via npm (Node.js $nodeVersion)..."
& npm install -g '@retrodeck/rdk@latest'
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "npm install failed (exit code $LASTEXITCODE)." -ForegroundColor Yellow
    Write-Host "Try running this PowerShell as Administrator, or: npm install -g @retrodeck/rdk"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "rdk installed."
Write-Host ""
Write-Host "Get started:"
Write-Host "  rdk init"
Write-Host ""
Write-Host "Docs: https://rdk.network/docs"
