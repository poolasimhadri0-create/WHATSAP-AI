# 🚀 WhatsApp AI Auto-Reply & Live Human Takeover System

A full-stack, enterprise-grade automated WhatsApp assistant powered by **Google Gemini AI** (ultra-fast sub-second responses), **FastAPI**, **MySQL** (with automatic local SQLite fallback), and a **React (TypeScript + Vite)** admin dashboard with real-time **WebSockets** and **human handoff**.

---

## 🌟 Key Features

1. **⚡ Ultra-Fast Google Gemini Auto-Reply (< 1-2 Seconds)**:
   - When a user sends a WhatsApp message, Google Gemini (`gemini-1.5-flash` or `gemini-2.0-flash`) generates human-like, accurate replies in milliseconds.
   - Preserves multi-turn conversation context (last 10–15 messages).
   - Injects business knowledge base (pricing, hours, FAQs, policies).
   - Clean WhatsApp markdown formatting (`*bold*`, `_italic_`, `~strike~`).

2. **🛡️ AI Guardrails & Automatic Human Handoff**:
   - Detects trigger keywords (e.g., *"talk to human"*, *"agent"*, *"complaint"*, *"speak with someone"*).
   - Automatically pauses AI replies for that contact and alerts the admin dashboard in real-time.

3. **👤 Live Agent Takeover Dashboard**:
   - Live inbox showing conversations, unread badges, and status (`🤖 AI Active` vs `👤 Human Takeover`).
   - One-click toggle switch to take over chat or return control to the AI.
   - Manual agent composer to send messages directly to the customer's WhatsApp via Meta Cloud API.

4. **⚙️ Dynamic AI Persona & Rules Editor**:
   - Live settings panel to modify System Prompts, Business Name, Hours, Greeting Message, and Trigger Keywords without redeploying the app.

5. **📱 Built-In WhatsApp Customer Simulator**:
   - Test incoming messages, AI replies, and handoffs right inside your browser without needing public webhooks or ngrok during development!

---

## 🛠️ Tech Stack

- **Frontend**: React 18, Vite, TypeScript, Tailwind CSS, Lucide Icons, Axios, WebSockets.
- **Backend**: Python 3.11+, FastAPI, SQLAlchemy 2.0 (async), Pydantic v2, `httpx`, WebSockets, JWT Auth.
- **AI Engine**: Google Gemini API (`gemini-1.5-flash` / `gemini-2.0-flash`), OpenAI, or Claude.
- **Messaging Channel**: Meta WhatsApp Cloud API (official Graph API v20.0).
- **Database**: MySQL 8.0 (async via `aiomysql`) with automatic SQLite fallback for zero-setup local dev.

---

## 🚀 Quick Start (Local Development)

### 1. Configure Environment Variables
Inside `backend/.env`:
```env
# Database (MySQL or leave default for automatic local SQLite fallback)
DATABASE_URL="mysql+aiomysql://root:password@localhost:3306/whatsapp_ai"
FALLBACK_TO_SQLITE=True

# Google Gemini API Key (Get free at: https://aistudio.google.com/)
LLM_PROVIDER="gemini"
GEMINI_API_KEY="your_gemini_api_key_here"
LLM_MODEL="gemini-1.5-flash"

# Meta WhatsApp Cloud API (Get from Meta Developers Console)
WHATSAPP_TOKEN="EAAB..."
WHATSAPP_PHONE_NUMBER_ID="your_phone_number_id"
WHATSAPP_WABA_ID="your_waba_id"
WHATSAPP_VERIFY_TOKEN="my_secure_verify_token_123"
META_APP_SECRET="your_meta_app_secret"
```

### 2. Launch the Application
Double-click `start_all.bat` on Windows, or start each service:

**Backend**:
```bash
cd backend
.\venv\Scripts\activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**Frontend**:
```bash
cd frontend
npm run dev
```

- **React Dashboard**: [http://localhost:5173](http://localhost:5173)
- **FastAPI Backend & Swagger Docs**: [http://localhost:8000/docs](http://localhost:8000/docs)
- **WebSocket Endpoint**: `ws://localhost:8000/ws/dashboard`

---

## 🔐 Default Login Credentials

- **Email**: `admin@example.com`
- **Password**: `admin123`

---

## 📲 Meta WhatsApp Cloud API Setup

1. Go to [developers.facebook.com](https://developers.facebook.com/) and create an App.
2. Select **WhatsApp** under products.
3. Obtain your:
   - `Temporary/Permanent Access Token` (`WHATSAPP_TOKEN`)
   - `Phone number ID` (`WHATSAPP_PHONE_NUMBER_ID`)
   - `WhatsApp Business Account ID` (`WHATSAPP_WABA_ID`)
4. In WhatsApp **Configuration** > **Webhook**:
   - Callback URL: `https://<your-domain>/webhook/whatsapp`
   - Verify Token: `my_secure_verify_token_123` (matching `WHATSAPP_VERIFY_TOKEN`)
5. Click **Verify and save**, then subscribe to the `messages` field.

---

## 🐳 Docker Deployment

To launch MySQL 8.0, FastAPI backend, and Nginx frontend in containers:
```bash
docker-compose up --build
```
Access the dashboard on `http://localhost:5173`.
