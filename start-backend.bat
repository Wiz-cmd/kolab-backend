@echo off
setlocal
cd /d "%~dp0"
echo Checking port 3000...
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul
if not errorlevel 1 (
  echo Backend already running on port 3000.
  exit /b 0
)
echo Starting Kolab backend...
start "Kolab Backend" /min cmd /c "node dist\src\main.js > backend.log 2>&1"
timeout /t 5 /nobreak >nul
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul
if errorlevel 1 (
  echo Port 3000 did not open. Check backend.err.log / backend.log.
  exit /b 1
)
echo Kolab backend running on http://localhost:3000/api
exit /b 0