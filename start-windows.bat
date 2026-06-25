@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Please install Node.js 18 or newer.
  pause
  exit /b 1
)
echo Starting Seedance Ad Picture Web UI...
echo Open http://localhost:5182/ on this computer.
echo LAN users can open http://YOUR-LAN-IP:5182/ after Windows Firewall allows Node.js.
node server.mjs
pause
