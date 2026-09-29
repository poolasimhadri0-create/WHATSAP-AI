from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class ContactBase(BaseModel):
    wa_phone_number: str
    name: Optional[str] = None
    is_blocked: bool = False
    handoff_to_human: bool = False


class ContactCreate(ContactBase):
    pass


class ContactUpdate(BaseModel):
    name: Optional[str] = None
    is_blocked: Optional[bool] = None
    handoff_to_human: Optional[bool] = None


class ContactOut(ContactBase):
    id: int
    created_at: datetime

    class Config:
        from_attributes = True
