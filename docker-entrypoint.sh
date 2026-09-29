#!/bin/bash
set -e

echo "=========================================================="
echo " Starting WhatsApp AI Bot (FastAPI + Gemini + WhatsApp) "
echo "=========================================================="

# Create persistent data directory if not exists
mkdir -p /app/backend/data
mkdir -p /app/whatsapp-bridge/auth_info_baileys

# Start FastAPI backend in background
echo "-> Starting FastAPI AI Backend on port 8000..."
cd /app/backend
uvicorn app.main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!

# Wait 2 seconds for backend to start up
sleep 2

# Start WhatsApp Web QR Bridge in background
echo "-> Starting WhatsApp Web QR Bridge on port 3001..."
cd /app/whatsapp-bridge
node index.js &
BRIDGE_PID=$!

# Trap signals for graceful shutdown
trap "kill -TERM $BACKEND_PID $BRIDGE_PID" SIGTERM SIGINT

# Wait for processes
wait $BACKEND_PID $BRIDGE_PID
