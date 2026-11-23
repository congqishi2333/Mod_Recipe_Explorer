$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '[recipe-analyzer] Node.js not found. Please install Node.js and try again.' -ForegroundColor Red
  Read-Host 'Press Enter to exit'
  exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
  Write-Host '[recipe-analyzer] Installing dependencies...'
  npm install
  if ($LASTEXITCODE -ne 0) {
    Write-Host '[recipe-analyzer] npm install failed.' -ForegroundColor Red
    Read-Host 'Press Enter to exit'
    exit 1
  }
}

Write-Host '[recipe-analyzer] Starting at http://127.0.0.1:3033'
Start-Process 'http://127.0.0.1:3033' | Out-Null
node server.js
if ($LASTEXITCODE -ne 0) { Read-Host 'Press Enter to exit' }
