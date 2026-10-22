@echo off
title WhatsApp AI Bot (Gemini)
echo ========================================================
echo        WhatsApp AI Bot - Gemini Auto-Reply
echo ========================================================
echo.

:: Detect root directory
set "ROOT_DIR=%~dp0"
if exist "%ROOT_DIR%..\backend" (
    cd /d "%ROOT_DIR%.."
    set "ROOT_DIR=%CD%\"
)

:: Clean up old hanging instances on ports 8000 and 3001
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /R ":8000 .*LISTENING"') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /R ":3001 .*LISTENING"') do taskkill /f /pid %%a >nul 2>&1

echo [1/2] Starting Gemini AI Engine (FastAPI)...
start "WhatsApp AI Engine" /min cmd /k "cd /d "%ROOT_DIR%backend" && .\venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000"

echo Waiting for AI backend to be ready...
for /l %%i in (1,1,10) do (
    curl -s http://127.0.0.1:8000/health >nul 2>&1
    if not errorlevel 1 goto backend_ready
    timeout /t 1 /nobreak >nul
)
:backend_ready
echo [OK] Gemini AI Engine is online and ready!
echo.

echo [2/2] Starting WhatsApp Connector...
echo.
echo ========================================================
echo   If you already scanned earlier, it will reconnect!
echo   Otherwise, SCAN THE QR CODE below with your WhatsApp:
echo   (WhatsApp > Settings > Linked Devices > Link a Device)
echo ========================================================
echo.
start "" "http://localhost:3001/qr"
cd /d "%ROOT_DIR%whatsapp-bridge"
node index.js
pause
