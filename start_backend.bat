@echo off
echo Starting WhatsApp AI Backend (FastAPI + Gemini)...
cd backend
call .\venv\Scripts\activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
pause
