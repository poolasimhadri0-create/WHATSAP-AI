from pydantic import BaseModel
from typing import Optional, Dict, Any
from datetime import datetime


class BotConfigItem(BaseModel):
    key: str
    value: str
    description: Optional[str] = None


class BotConfigUpdate(BaseModel):
    configs: Dict[str, str]  # key -> value map


class BotConfigOut(BaseModel):
    id: int
    key: str
    value: str
    description: Optional[str] = None
    updated_at: datetime

    class Config:
        from_attributes = True


class BotConfigResponse(BaseModel):
    system_prompt: str
    persona_name: str
    business_name: str
    business_hours: str
    greeting_message: str
    trigger_keywords: str
    knowledge_base: str
    model_name: str
    typing_delay_enabled: bool
    typing_delay_sec: float
