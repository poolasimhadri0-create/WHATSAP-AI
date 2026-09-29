# ==========================================================
# WhatsApp AI Bot Production Dockerfile
# Packages FastAPI (Gemini AI Engine) + WhatsApp Web Bridge
# ==========================================================

FROM python:3.11-slim

# Set environment
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    FASTAPI_URL="http://127.0.0.1:8000/api/v1/bridge/incoming"

WORKDIR /app

# Install system dependencies & Node.js 20
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    build-essential \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 1. Install Backend Python Dependencies
COPY backend/requirements.txt /app/backend/
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

# 2. Install WhatsApp Bridge Node Dependencies
COPY whatsapp-bridge/package*.json /app/whatsapp-bridge/
RUN cd /app/whatsapp-bridge && npm install --omit=dev

# 3. Copy Application Source Code
COPY backend/ /app/backend/
COPY whatsapp-bridge/ /app/whatsapp-bridge/
COPY docker-entrypoint.sh /app/

RUN chmod +x /app/docker-entrypoint.sh

# Volumes for persistent database & WhatsApp QR session
VOLUME ["/app/backend/data", "/app/whatsapp-bridge/auth_info_baileys"]

# Expose FastAPI backend (8000) and WhatsApp Bridge (3001)
EXPOSE 8000 3001

CMD ["/bin/bash", "/app/docker-entrypoint.sh"]
