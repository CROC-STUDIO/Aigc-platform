$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js is required. Please install Node.js 18 or newer."
  Read-Host "Press Enter to exit"
  exit 1
}
Write-Host "Starting Seedance Ad Picture Web UI..."
Write-Host "Open http://localhost:5177/ on this computer."
Write-Host "LAN users can open http://YOUR-LAN-IP:5177/ after Windows Firewall allows Node.js."
node server.mjs
