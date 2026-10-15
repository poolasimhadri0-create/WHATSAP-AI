#!/bin/bash
set -e

echo "=========================================================="
echo " Starting WhatsApp AI Bot (FastAPI + Gemini + WhatsApp) "
echo "=========================================================="

# Create persistent data directory if not exists
mkdir -p /app/backend/data
mkdir -p /app/whatsapp-bridge/auth_info_baileys

# Start FastAPI backend in background
SERVER_PORT=${PORT:-8000}
echo "-> Starting FastAPI AI Backend on port $SERVER_PORT..."
cd /app/backend
uvicorn app.main:app --host 0.0.0.0 --port $SERVER_PORT &
BACKEND_PID=$!

# Wait 2 seconds for backend to start up
sleep 2

# Start WhatsApp Web QR Bridge in background on fixed port 3001
echo "-> Starting WhatsApp Web QR Bridge on port 3001..."
cd /app/whatsapp-bridge
BRIDGE_PORT=3001 node index.js &
BRIDGE_PID=$!

# Trap signals for graceful shutdown
trap "kill -TERM $BACKEND_PID $BRIDGE_PID" SIGTERM SIGINT

# Wait for processes
wait $BACKEND_PID $BRIDGE_PID
