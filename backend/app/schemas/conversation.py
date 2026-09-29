from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
from app.models.conversation import ConversationStatus
from app.schemas.contact import ContactOut
from app.schemas.message import MessageOut


class ConversationBase(BaseModel):
    contact_id: int
    status: ConversationStatus = ConversationStatus.active


class ConversationCreate(ConversationBase):
    pass


class ConversationOut(BaseModel):
    id: int
    contact_id: int
    status: ConversationStatus
    started_at: datetime
    last_message_at: datetime
    contact: Optional[ContactOut] = None
    last_message: Optional[MessageOut] = None
    unread_count: int = 0

    class Config:
        from_attributes = True


class ConversationDetailOut(ConversationOut):
    messages: List[MessageOut] = []


class HandoffToggleRequest(BaseModel):
    handoff_to_human: bool
