import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select

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

@app.api_route("/", methods=["GET", "HEAD"])
async def root():
    return {
        "status": "online",
        "service": "WhatsApp AI Engine (Gemini)",
        "message": "AI Engine is active and ready to reply to WhatsApp chats!",
        "whatsapp_bridge": "http://127.0.0.1:3001/status"
    }

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
