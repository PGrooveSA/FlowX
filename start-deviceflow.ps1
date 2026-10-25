# Starts DeviceFlow on this computer.
#   .\start-deviceflow.ps1          -> production build served at http://localhost:5180
#   .\start-deviceflow.ps1 -Dev     -> Vite dev server with hot reload
# Requires Docker Desktop to be running.
param([switch]$Dev)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host 'Starting the local Supabase stack (database, auth, storage, edge functions)...'
npx supabase start | Out-Null
if (-not (Test-Path .env.local)) { node scripts/write-env.mjs }

if ($Dev) {
  npm run dev
} else {
  npm run build
  Write-Host 'DeviceFlow is available at http://localhost:5180 (Ctrl+C to stop the web server).'
  npm run preview
}
