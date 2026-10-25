@echo off
setlocal
rem ==========================================================================
rem  DeviceFlow - start the app on this computer
rem    start.bat         production build served at http://localhost:5180
rem    start.bat dev     Vite dev server with hot reload
rem  Requires Node.js 20+ and Docker Desktop.
rem ==========================================================================
cd /d "%~dp0"
title DeviceFlow

where node >nul 2>nul || (echo [ERROR] Node.js is not installed or not on PATH. Install it from https://nodejs.org & goto :fail)

docker info >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Docker is not running. Start Docker Desktop, wait until it is ready, then run start.bat again.
  goto :fail
)

if not exist node_modules (
  echo Installing dependencies ^(first run only^)...
  call npm install --no-fund --no-audit || goto :fail
)

echo Starting the local Supabase stack ^(database, auth, storage, edge functions^)...
call npx supabase start >nul || (echo [ERROR] Supabase failed to start. Run "npx supabase start" to see the details. & goto :fail)

if not exist .env.local (
  echo Writing .env.local for the local stack...
  call node scripts/write-env.mjs || goto :fail
)

rem Creates the demo accounts on first run; skips the demo workflows if data already exists.
echo Checking demo accounts...
call node --env-file=.env.local scripts/seed-demo.mjs >nul 2>nul
if errorlevel 1 echo [WARN] Demo accounts could not be prepared. Run "npm run setup:demo" for details.

echo.
echo  DeviceFlow      http://localhost:5180
echo  Supabase Studio http://127.0.0.1:55423
echo  Test mailbox    http://127.0.0.1:55424
echo  Demo password:  DEMO_USER_PASSWORD in .env.local
echo  Press Ctrl+C to stop the web server. "npx supabase stop" stops the database.
echo.

if /i "%~1"=="dev" (
  start "" http://localhost:5180
  call npm run dev
) else (
  echo Building the app...
  call npm run build >nul || (echo [ERROR] Build failed. Run "npm run build" to see the errors. & goto :fail)
  start "" http://localhost:5180
  call npm run preview
)
goto :eof

:fail
echo.
pause
exit /b 1