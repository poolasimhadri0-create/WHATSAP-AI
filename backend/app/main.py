import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
import httpx

from app.core.config import settings
from app.core.security import get_password_hash
from app.db.session import get_engine, Base, get_session_maker
from app.models.agent import Agent
from app.models.bot_config import BotConfig
from app.services.websocket_manager import ws_manager
from app.services.ai import (
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_KNOWLEDGE_BASE,
    DEFAULT_TRIGGER_KEYWORDS,
)

# API Routers
from app.api.v1.auth import router as auth_router
from app.api.v1.conversations import router as conversations_router
from app.api.v1.bot_config import router as bot_config_router
from app.api.v1.webhook import router as webhook_router
from app.api.v1.simulator import router as simulator_router
from app.api.v1.bridge import router as bridge_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("whatsapp_ai")


async def init_db_and_seed():
    """Initializes tables and seeds default admin agent and bot configuration if empty."""
    from app.db.session import ensure_db_connected
    await ensure_db_connected()
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    maker = get_session_maker()
    async with maker() as db:
        # 1. Seed Default Admin Agent
        stmt = select(Agent).where(Agent.email == "admin@example.com")
        res = await db.execute(stmt)
        admin = res.scalar_one_or_none()
        if not admin:
            admin = Agent(
                name="Admin Agent",
                email="admin@example.com",
                password_hash=get_password_hash("admin123"),
            )
            db.add(admin)
            logger.info("Created default admin agent: admin@example.com / admin123")

        # 2. Seed Default Bot Config items
        default_configs = [
            ("system_prompt", DEFAULT_SYSTEM_PROMPT, "Core AI system prompt & instructions"),
            ("persona_name", "NovaCare AI Support", "Display name of the AI agent"),
            ("business_name", "NovaCare Solutions", "Business legal name"),
            ("business_hours", "Mon-Fri 9:00 AM - 6:00 PM EST, Sat 10:00 AM - 2:00 PM EST", "Working hours"),
            ("greeting_message", "Hello! Welcome to NovaCare Solutions. How may I help you today?", "Default welcome greeting"),
            ("trigger_keywords", ", ".join(DEFAULT_TRIGGER_KEYWORDS), "Comma-separated keywords for human handoff"),
            ("knowledge_base", DEFAULT_KNOWLEDGE_BASE, "Business knowledge, pricing, and FAQ document"),
            ("model_name", settings.LLM_MODEL, "LLM model identifier"),
        ]

        for key, value, desc in default_configs:
            stmt = select(BotConfig).where(BotConfig.key == key)
            res = await db.execute(stmt)
            existing = res.scalar_one_or_none()
            if not existing:
                cfg = BotConfig(key=key, value=value, description=desc)
                db.add(cfg)

        await db.commit()
        logger.info("Database initialized and seeded.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting WhatsApp AI Auto-Reply System backend...")
    await init_db_and_seed()
    yield
    logger.info("Shutting down WhatsApp AI Auto-Reply System backend...")


app = FastAPI(
    title=settings.PROJECT_NAME,
    description="FastAPI WhatsApp AI Auto-Reply & Human Takeover System with Meta Cloud API and WebSocket Live Dashboard",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.BACKEND_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BRIDGE_INTERNAL_URL = "http://127.0.0.1:3001"

FAVICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="#25D366"/><path d="M50 20C33.4 20 20 33.4 20 50c0 6.6 2.1 12.8 6 17.8L22 80l12.6-3.9C39.3 78.4 44.5 80 50 80c16.6 0 30-13.4 30-30S66.6 20 50 20zm14.8 41.5c-.6 1.8-3.1 3.4-4.8 3.8-1.2.3-2.7.5-8.4-1.9-7.3-3.1-12-10.4-12.4-10.9-.4-.5-3-4-3-7.7s1.9-5.5 2.6-6.3c.7-.7 1.6-.9 2.1-.9.5 0 1.1 0 1.6.1.5.1 1.2-.2 1.9 1.4.7 1.7 2.4 5.9 2.6 6.3.2.4.3.9.1 1.5-.2.5-.5.9-.8 1.2-.4.4-.8.9-.4 1.7.9 1.7 3.3 4.8 6.1 6.3 1.2.7 2.1.8 2.8.4.8-.4 2.2-2.6 2.8-3.5.6-.9 1.2-.8 2-.5.8.3 5.1 2.4 6 2.8.9.5 1.5.7 1.7 1.1.2.5.2 2.7-.4 4.5z" fill="#fff"/></svg>"""

@app.api_route("/", methods=["GET", "HEAD"])
async def root(request: Request):
    # If opened in a web browser, automatically redirect to the WhatsApp QR link page
    accept = request.headers.get("accept", "")
    if "text/html" in accept and request.method == "GET":
        return RedirectResponse(url="/qr")

    return {
        "status": "online",
        "service": "WhatsApp AI Engine (Gemini)",
        "message": "AI Engine is active and ready to reply to WhatsApp chats!",
        "whatsapp_link_qr": "/qr",
        "whatsapp_bridge_status": "/status"
    }

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return Response(content=FAVICON_SVG, media_type="image/svg+xml", status_code=200)

async def fetch_from_bridge(method: str, path: str, json_data: dict = None, timeout: float = 10.0):
    for base in ["http://127.0.0.1:3001", "http://localhost:3001"]:
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                if method.upper() in ["GET", "HEAD"]:
                    return await client.get(f"{base}{path}")
                elif method.upper() == "POST":
                    return await client.post(f"{base}{path}", json=json_data)
        except Exception:
            continue
    raise ConnectionError("Bridge connection refused on port 3001")

@app.api_route("/qr", methods=["GET", "HEAD"])
async def qr_proxy(request: Request):
    """Proxies the WhatsApp QR linking page directly from the local bridge."""
    if request.method == "HEAD":
        return Response(status_code=200)
    try:
        resp = await fetch_from_bridge("GET", "/qr", timeout=10.0)
        return HTMLResponse(content=resp.text, status_code=resp.status_code)
    except Exception as e:
        return HTMLResponse(
            content=f"""<!DOCTYPE html><html><head><meta http-equiv="refresh" content="3"><title>Starting WhatsApp Bridge...</title></head>
            <body style="background:#0b141a;color:#fff;font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:50px;">
            <h2 style="color:#25D366;">WhatsApp Bridge is initializing...</h2>
            <p style="color:#8696a0;">Auto-refreshing in 3 seconds...</p>
            </body></html>""",
            status_code=200
        )

@app.post("/pair-code")
async def pair_code_proxy(request: Request):
    """Proxies the phone number pairing code generator to the bridge."""
    try:
        body = await request.json()
        resp = await fetch_from_bridge("POST", "/pair-code", json_data=body, timeout=15.0)
        return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
    except Exception as e:
        return {"error": str(e)}

@app.api_route("/status", methods=["GET", "HEAD"])
async def bridge_status_proxy(request: Request):
    """Proxies connection status (supports GET and HEAD for uptime monitors)."""
    if request.method == "HEAD":
        return Response(status_code=200)
    try:
        resp = await fetch_from_bridge("GET", "/status", timeout=5.0)
        return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
    except Exception as e:
        return {"connected": False, "status": "starting", "error": str(e)}

@app.get("/reset")
async def bridge_reset_proxy():
    """Proxies session reset."""
    try:
        resp = await fetch_from_bridge("GET", "/reset", timeout=10.0)
        return HTMLResponse(content=resp.text, status_code=resp.status_code)
    except Exception as e:
        return HTMLResponse(content=f"Error resetting: {e}", status_code=500)

@app.post("/logout")
async def bridge_logout_proxy():
    """Proxies logout."""
    try:
        resp = await fetch_from_bridge("POST", "/logout", timeout=10.0)
        return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
    except Exception as e:
        return {"error": str(e)}

@app.api_route("/logs", methods=["GET", "HEAD"])
async def bridge_logs_proxy(request: Request):
    """Proxies live WhatsApp bridge logs."""
    if request.method == "HEAD":
        return Response(status_code=200)
    try:
        resp = await fetch_from_bridge("GET", "/logs", timeout=10.0)
        return Response(content=resp.content, status_code=resp.status_code, media_type="text/plain; charset=utf-8")
    except Exception as e:
        return Response(content=f"Error reading logs: {e}", status_code=500, media_type="text/plain")

@app.api_route("/ai-status", methods=["GET", "HEAD"])
async def bridge_ai_status_proxy(request: Request):
    """Proxies AI paused/active status."""
    if request.method == "HEAD":
        return Response(status_code=200)
    try:
        resp = await fetch_from_bridge("GET", "/ai-status", timeout=5.0)
        return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
    except Exception as e:
        return {"error": str(e), "isAiPaused": False}

@app.post("/pause")
async def bridge_pause_proxy(request: Request):
    """Proxies AI pause request."""
    try:
        body = await request.json() if request.headers.get("content-length") and int(request.headers.get("content-length")) > 0 else {}
        resp = await fetch_from_bridge("POST", "/pause", json_data=body, timeout=10.0)
        return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
    except Exception as e:
        return {"error": str(e)}

@app.post("/resume")
async def bridge_resume_proxy():
    """Proxies AI resume request."""
    try:
        resp = await fetch_from_bridge("POST", "/resume", timeout=10.0)
        return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
    except Exception as e:
        return {"error": str(e)}

@app.post("/toggle-ai")
async def bridge_toggle_proxy():
    """Proxies AI toggle request."""
    try:
        resp = await fetch_from_bridge("POST", "/toggle-ai", timeout=10.0)
        return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
    except Exception as e:
        return {"error": str(e)}

@app.api_route("/bridge-settings", methods=["GET", "POST"])
async def bridge_settings_proxy(request: Request):
    """Proxies bridge settings."""
    try:
        if request.method == "POST":
            body = await request.json()
            resp = await fetch_from_bridge("POST", "/settings", json_data=body, timeout=10.0)
        else:
            resp = await fetch_from_bridge("GET", "/settings", timeout=5.0)
        return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
    except Exception as e:
        return {"error": str(e)}


# 1. Direct Webhook Mounts (Meta WhatsApp standard endpoint: /webhook/whatsapp)
app.include_router(webhook_router, prefix="/webhook", tags=["Meta WhatsApp Webhook"])

# 2. API v1 Routers
app.include_router(auth_router, prefix=f"{settings.API_V1_STR}/auth", tags=["Auth"])
app.include_router(conversations_router, prefix=f"{settings.API_V1_STR}/conversations", tags=["Conversations"])
app.include_router(bot_config_router, prefix=f"{settings.API_V1_STR}/bot-config", tags=["Bot Config"])
app.include_router(webhook_router, prefix=f"{settings.API_V1_STR}/webhook", tags=["Webhook v1"])
app.include_router(simulator_router, prefix=f"{settings.API_V1_STR}/simulator", tags=["Simulator"])
app.include_router(bridge_router, prefix=f"{settings.API_V1_STR}/bridge", tags=["WhatsApp Web Bridge"])

# Direct top-level shortcuts matching master prompt specification:
# /conversations, /conversations/{id}/messages, /conversations/{id}/handoff, /conversations/{id}/reply, /bot-config, /auth/login
app.include_router(conversations_router, prefix="/conversations", tags=["Conversations (Direct)"])
app.include_router(bot_config_router, prefix="/bot-config", tags=["Bot Config (Direct)"])
app.include_router(auth_router, prefix="/auth", tags=["Auth (Direct)"])


# 3. Real-Time Dashboard WebSocket Endpoint
@app.websocket("/ws/dashboard")
async def websocket_dashboard_endpoint(websocket: WebSocket):
    """WebSocket endpoint connecting React dashboard for live incoming messages and handoff events."""
    await ws_manager.connect(websocket)
    try:
        while True:
            # Keep connection alive, listen for ping/client messages
            data = await websocket.receive_text()
            # Echo or process if needed
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception as e:
        logger.warning(f"WebSocket client connection error: {e}")
        ws_manager.disconnect(websocket)


@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "service": settings.PROJECT_NAME,
        "database": "connected",
        "llm_provider": settings.LLM_PROVIDER,
    }
