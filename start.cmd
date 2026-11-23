@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [recipe-analyzer] Node.js not found. Please install Node.js and try again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [recipe-analyzer] Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [recipe-analyzer] npm install failed.
    pause
    exit /b 1
  )
)

echo [recipe-analyzer] Starting at http://127.0.0.1:3033
start "" http://127.0.0.1:3033
node server.js
if errorlevel 1 pause
