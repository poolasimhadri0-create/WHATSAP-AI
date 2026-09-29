from pydantic import BaseModel
from typing import Optional
from datetime import datetime
from app.models.message import MessageSender, MessageStatus


class MessageBase(BaseModel):
    content: str
    sender: MessageSender = MessageSender.agent
    wa_message_id: Optional[str] = None
    status: MessageStatus = MessageStatus.sent


class MessageCreate(BaseModel):
    content: str


class MessageOut(BaseModel):
    id: int
    conversation_id: int
    sender: MessageSender
    content: str
    wa_message_id: Optional[str] = None
    status: MessageStatus
    created_at: datetime

    class Config:
        from_attributes = True
