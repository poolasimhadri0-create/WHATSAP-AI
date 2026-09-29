@echo off
title AI Status Check
echo ========================================================
echo               WhatsApp AI Status Check
echo ========================================================
echo.
echo [1/3] Checking Port 8000 (AI Engine)...
powershell -Command "$c = Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue; if ($c) { Write-Host '  --> AI Engine: RUNNING (Port 8000)' -ForegroundColor Green } else { Write-Host '  --> AI Engine: NOT RUNNING' -ForegroundColor Red }"

echo.
echo [2/3] Checking Port 3001 (WhatsApp Bridge)...
powershell -Command "$c = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue; if ($c) { Write-Host '  --> WhatsApp Bridge: RUNNING (Port 3001)' -ForegroundColor Green } else { Write-Host '  --> WhatsApp Bridge: NOT RUNNING' -ForegroundColor Red }"

echo.
echo [3/3] Sending Test Question to Gemini AI...
powershell -Command "$body = @{ sender_phone = '1234567890'; sender_name = 'Tester'; message_text = 'Hello, can you introduce yourself?' } | ConvertTo-Json; try { $res = Invoke-RestMethod -Uri 'http://localhost:8000/api/v1/bridge/incoming' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 15; Write-Host '  --> AI Status: WORKING PERFECTLY!' -ForegroundColor Green; Write-Host ''; Write-Host 'AI Response:' -ForegroundColor Cyan; Write-Host $res.reply; } catch { Write-Host '  --> Error:' $_.Exception.Message -ForegroundColor Red }"

echo.
echo ========================================================
pause
