@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install Node.js 18+ from https://nodejs.org
  pause
  exit /b 1
)

echo Starting Mobius Music server...
echo.
node server.js --open
pause
