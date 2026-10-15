from datetime import datetime, timezone
from typing import Optional
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.contact import Contact
from app.models.conversation import Conversation, ConversationStatus
from app.models.message import Message, MessageSender, MessageStatus
from app.services.ai import generate_llm_reply
from app.services.websocket_manager import ws_manager

router = APIRouter()


class BridgeIncomingPayload(BaseModel):
    sender_phone: str
    sender_name: Optional[str] = "WhatsApp User"
    message_text: str
    message_id: Optional[str] = None


import json
from pathlib import Path

def is_phone_blacklisted(phone: str) -> bool:
    """Check if phone number is listed in blacklist.json."""
    try:
        possible_paths = [
            Path(__file__).resolve().parents[4] / "whatsapp-bridge" / "blacklist.json",
            Path("whatsapp-bridge/blacklist.json"),
            Path("../whatsapp-bridge/blacklist.json"),
            Path("blacklist.json")
        ]
        for p in possible_paths:
            if p.exists():
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    ignored_numbers = data.get("ignored_numbers", [])
                    clean_phone = "".join(filter(str.isdigit, str(phone)))
                    for num in ignored_numbers:
                        clean_num = "".join(filter(str.isdigit, str(num)))
                        if clean_num:
                            if clean_phone == clean_num:
                                return True
                            if len(clean_phone) >= 7 and len(clean_num) >= 7:
                                if clean_phone.endsWith(clean_num) if hasattr(clean_phone, "endsWith") else (clean_phone.endswith(clean_num) or clean_num.endswith(clean_phone)):
                                    return True
    except Exception:
        pass
    return False


@router.post("/incoming")
async def handle_bridge_incoming_message(
    payload: BridgeIncomingPayload,
    db: AsyncSession = Depends(get_db)
):
    """
    Receives an incoming message from the local WhatsApp Web QR Bridge,
    saves it to the database, invokes Gemini AI for an instant reply (if handoff is off),
    and broadcasts to the React dashboard over WebSocket.
    """
    clean_phone = payload.sender_phone.replace("+", "").replace(" ", "").replace("-", "").strip()
    if not clean_phone or not payload.message_text.strip():
        raise HTTPException(status_code=400, detail="Invalid message or phone")

    # Check blacklist
    if is_phone_blacklisted(clean_phone):
        return {
            "reply": None,
            "handoff": False,
            "message": f"Phone number {clean_phone} is blacklisted from AI replies."
        }

    # Strict protection: Never reply to groups
    if "g.us" in payload.sender_phone or "group" in payload.sender_phone.lower():
        return {
            "reply": None,
            "handoff": False,
            "message": "Group chats are blocked from AI auto-replies."
        }



    # 1. Upsert Contact
    stmt = select(Contact).where(Contact.wa_phone_number == clean_phone)
    res = await db.execute(stmt)
    contact = res.scalar_one_or_none()
    if not contact:
        contact = Contact(
            wa_phone_number=clean_phone,
            name=payload.sender_name or "WhatsApp User",
            handoff_to_human=False
        )
        db.add(contact)
        await db.flush()
    else:
        if payload.sender_name and payload.sender_name != "WhatsApp User":
            contact.name = payload.sender_name

    # 2. Upsert Conversation
    stmt = (
        select(Conversation)
        .options(selectinload(Conversation.messages))
        .where(
            Conversation.contact_id == contact.id,
            Conversation.status == ConversationStatus.active
        )
        .order_by(Conversation.started_at.desc())
    )
    res = await db.execute(stmt)
    conversation = res.scalar_one_or_none()

    if not conversation:
        conversation = Conversation(
            contact_id=contact.id,
            status=ConversationStatus.active,
            started_at=datetime.now(timezone.utc),
            last_message_at=datetime.now(timezone.utc)
        )
        db.add(conversation)
        await db.flush()

    # 3. Save User Message
    user_msg = Message(
        conversation_id=conversation.id,
        sender=MessageSender.user,
        content=payload.message_text,
        wa_message_id=payload.message_id,
        status=MessageStatus.delivered,
        created_at=datetime.now(timezone.utc)
    )
    db.add(user_msg)
    conversation.last_message_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(user_msg)

    # 4. Broadcast to React Dashboard
    await ws_manager.broadcast("new_message", {
        "conversation_id": conversation.id,
        "contact": {
            "id": contact.id,
            "name": contact.name,
            "wa_phone_number": contact.wa_phone_number,
            "handoff_to_human": contact.handoff_to_human,
        },
        "message": {
            "id": user_msg.id,
            "conversation_id": conversation.id,
            "sender": user_msg.sender.value,
            "content": user_msg.content,
            "status": user_msg.status.value,
            "created_at": user_msg.created_at.isoformat(),
        }
    })

    # 5. Check Human Handoff status
    if contact.handoff_to_human:
        await ws_manager.broadcast("human_attention_needed", {
            "conversation_id": conversation.id,
            "contact_name": contact.name,
            "phone": contact.wa_phone_number,
            "last_message": payload.message_text
        })
        return {
            "reply": None,
            "handoff": True,
            "message": "Human takeover active. AI reply suppressed."
        }

    # 6. Fetch conversation context and invoke Gemini AI
    stmt = (
        select(Message)
        .where(Message.conversation_id == conversation.id)
        .order_by(Message.created_at.asc())
    )
    res = await db.execute(stmt)
    history = res.scalars().all()

    ai_reply_text, handoff_triggered = await generate_llm_reply(
        messages_history=history,
        user_latest_message=payload.message_text,
        db=db
    )

    if handoff_triggered:
        contact.handoff_to_human = True
        await db.commit()
        await ws_manager.broadcast("handoff_updated", {
            "conversation_id": conversation.id,
            "contact_id": contact.id,
            "handoff_to_human": True,
            "reason": "Trigger phrase detected by AI guardrails"
        })

    # 7. Save AI message to DB
    ai_msg = Message(
        conversation_id=conversation.id,
        sender=MessageSender.ai,
        content=ai_reply_text,
        status=MessageStatus.sent,
        created_at=datetime.now(timezone.utc)
    )
    db.add(ai_msg)
    conversation.last_message_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(ai_msg)

    # 8. Broadcast AI message to React Dashboard
    await ws_manager.broadcast("new_message", {
        "conversation_id": conversation.id,
        "message": {
            "id": ai_msg.id,
            "conversation_id": conversation.id,
            "sender": ai_msg.sender.value,
            "content": ai_msg.content,
            "status": ai_msg.status.value,
            "created_at": ai_msg.created_at.isoformat(),
        }
    })

    # Return reply text to WhatsApp Web bridge to send to sender!
    return {
        "reply": ai_reply_text,
        "handoff": handoff_triggered,
    }
