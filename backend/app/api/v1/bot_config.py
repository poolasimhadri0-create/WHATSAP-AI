from typing import Dict, Any
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db
from app.api.deps import get_current_agent
from app.models.agent import Agent
from app.models.bot_config import BotConfig
from app.schemas.bot_config import BotConfigResponse, BotConfigUpdate
from app.services.ai import (
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_KNOWLEDGE_BASE,
    DEFAULT_TRIGGER_KEYWORDS,
    get_bot_configuration,
)
from app.core.config import settings

router = APIRouter()


@router.get("", response_model=BotConfigResponse)
async def get_config(
    db: AsyncSession = Depends(get_db),
    current_agent: Agent = Depends(get_current_agent)
):
    """Retrieve full AI bot persona, prompts, business rules, and triggers."""
    config_dict = await get_bot_configuration(db)
    return BotConfigResponse(
        system_prompt=config_dict.get("system_prompt", DEFAULT_SYSTEM_PROMPT),
        persona_name=config_dict.get("persona_name", "Support Assistant"),
        business_name=config_dict.get("business_name", "NovaCare Solutions"),
        business_hours=config_dict.get("business_hours", "Mon-Fri 9AM-6PM EST"),
        greeting_message=config_dict.get("greeting_message", "Hello! Welcome to NovaCare Solutions."),
        trigger_keywords=config_dict.get("trigger_keywords", ", ".join(DEFAULT_TRIGGER_KEYWORDS)),
        knowledge_base=config_dict.get("knowledge_base", DEFAULT_KNOWLEDGE_BASE),
        model_name=config_dict.get("model_name", settings.LLM_MODEL),
        typing_delay_enabled=settings.TYPING_DELAY_ENABLED,
        typing_delay_sec=settings.TYPING_DELAY_MIN_SEC,
    )


@router.put("")
async def update_config(
    update_data: BotConfigUpdate,
    db: AsyncSession = Depends(get_db),
    current_agent: Agent = Depends(get_current_agent)
):
    """
    Update bot configuration parameters dynamically without redeploying.
    Key-value pairs are stored in the bot_config table.
    """
    for key, value in update_data.configs.items():
        stmt = select(BotConfig).where(BotConfig.key == key)
        result = await db.execute(stmt)
        item = result.scalar_one_or_none()
        if item:
            item.value = value
            item.updated_at = datetime.now(timezone.utc)
        else:
            new_item = BotConfig(
                key=key,
                value=value,
                updated_at=datetime.now(timezone.utc)
            )
            db.add(new_item)

    await db.commit()
    return {"message": "Configuration updated successfully", "updated_keys": list(update_data.configs.keys())}
