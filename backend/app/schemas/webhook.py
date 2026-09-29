from pydantic import BaseModel
from typing import List, Optional, Any, Dict


class WhatsAppText(BaseModel):
    body: str


class WhatsAppMessage(BaseModel):
    from_: str = ""
    id: str
    timestamp: str
    type: str
    text: Optional[WhatsAppText] = None

    class Config:
        fields = {"from_": "from"}


class WhatsAppProfile(BaseModel):
    name: Optional[str] = "Customer"


class WhatsAppContact(BaseModel):
    profile: Optional[WhatsAppProfile] = None
    wa_id: str


class WhatsAppValue(BaseModel):
    messaging_product: str
    metadata: Dict[str, Any]
    contacts: Optional[List[WhatsAppContact]] = None
    messages: Optional[List[Dict[str, Any]]] = None
    statuses: Optional[List[Dict[str, Any]]] = None


class WhatsAppChange(BaseModel):
    value: WhatsAppValue
    field: str


class WhatsAppEntry(BaseModel):
    id: str
    changes: List[WhatsAppChange]


class WhatsAppWebhookPayload(BaseModel):
    object: str
    entry: List[WhatsAppEntry]
