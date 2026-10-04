@echo off
setlocal enableextensions
cd /d "%~dp0"

rem ============================================================
rem  Data Agent - one-click launcher
rem  Model:  DeepSeek Flash (additional providers are configured in the UI)
rem  UI:     http://127.0.0.1:3080  (opens automatically)
rem  Configure DEEPSEEK_API_KEY in credential storage or an ignored .env file.
rem ============================================================

if not exist ".env" (
  echo [start.bat] No .env found. Configure a model API in the UI before sending an analysis.
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [start.bat] pnpm not found. Install Node 22+ first, then: npm install -g pnpm
  pause
  exit /b 1
)

if not exist "packages\bundle\web-app\node_modules\@deepseek-ai\dsh-experimental-data-agent" (
  echo [start.bat] Installing dependencies ^(first run^)...
  call pnpm install
  if errorlevel 1 (
    echo [start.bat] pnpm install failed.
    pause
    exit /b 1
  )
)

if not exist "packages\experimental\data-agent\lib\index.js" (
  echo [start.bat] Building host packages ^(first run, several minutes^)...
  call pnpm run build:lib:host
  if errorlevel 1 (
    echo [start.bat] Host build failed.
    pause
    exit /b 1
  )
)

if not exist "packages\experimental\data-agent\lib\client.js" (
  echo [start.bat] Building client packages...
  call pnpm run build:lib:client
  if errorlevel 1 (
    echo [start.bat] Client build failed.
    pause
    exit /b 1
  )
)

if not exist "apps\dataagent-ui\dist\index.html" (
  echo [start.bat] Building data agent UI...
  call pnpm --filter dataagent-ui run build
  if errorlevel 1 (
    echo [start.bat] Data agent UI build failed.
    pause
    exit /b 1
  )
)

if not exist "apps\web\dist\index.html" (
  echo [start.bat] Building web frontend ^(first run^)...
  call pnpm run build:web
  if errorlevel 1 (
    echo [start.bat] Web frontend build failed.
    pause
    exit /b 1
  )
)

echo [start.bat] Starting dsh web at http://127.0.0.1:3080 ...
call pnpm exec tsx scripts/prepare-data-agent-profile.ts
if errorlevel 1 (
  echo [start.bat] Data Agent profile preparation failed.
  pause
  exit /b 1
)
call pnpm dsh --profile data-agent

echo [start.bat] dsh exited.
pause
