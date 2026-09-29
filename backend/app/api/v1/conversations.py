from typing import List, Optional
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select, func, desc
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.api.deps import get_current_agent
from app.models.agent import Agent
from app.models.conversation import Conversation, ConversationStatus
from app.models.contact import Contact
from app.models.message import Message, MessageSender, MessageStatus
from app.schemas.conversation import ConversationOut, HandoffToggleRequest
from app.schemas.message import MessageOut, MessageCreate
from app.services.whatsapp import send_whatsapp_message
from app.services.websocket_manager import ws_manager

router = APIRouter()


@router.get("", response_model=List[ConversationOut])
async def list_conversations(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    status_filter: Optional[ConversationStatus] = None,
    db: AsyncSession = Depends(get_db),
    current_agent: Agent = Depends(get_current_agent)
):
    """
    List all conversations (paginated, sorted by last_message_at descending)
    with contact details and latest message preview.
    """
    stmt = (
        select(Conversation)
        .options(
            selectinload(Conversation.contact),
            selectinload(Conversation.messages)
        )
        .order_by(desc(Conversation.last_message_at))
    )

    if status_filter:
        stmt = stmt.where(Conversation.status == status_filter)

    stmt = stmt.offset(skip).limit(limit)
    result = await db.execute(stmt)
    conversations = result.scalars().all()

    conv_list = []
    for conv in conversations:
        # Get latest message
        last_msg = conv.messages[-1] if conv.messages else None
        # Calculate unread count (e.g., user messages that haven't been responded to or marked read)
        unread_count = sum(1 for m in conv.messages if m.sender == MessageSender.user and m.status != MessageStatus.read)
        
        conv_out = ConversationOut(
            id=conv.id,
            contact_id=conv.contact_id,
            status=conv.status,
            started_at=conv.started_at,
            last_message_at=conv.last_message_at,
            contact=conv.contact,
            last_message=last_msg,
            unread_count=unread_count
        )
        conv_list.append(conv_out)

    return conv_list


@router.get("/{conversation_id}/messages", response_model=List[MessageOut])
async def get_conversation_messages(
    conversation_id: int,
    db: AsyncSession = Depends(get_db),
    current_agent: Agent = Depends(get_current_agent)
):
    """Fetch full chronological message history for a conversation."""
    stmt = (
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.asc())
    )
    result = await db.execute(stmt)
    messages = result.scalars().all()
    
    # Mark user messages as read when agent views them
    for m in messages:
        if m.sender == MessageSender.user and m.status != MessageStatus.read:
            m.status = MessageStatus.read
    await db.commit()

    return messages


@router.post("/{conversation_id}/handoff")
async def toggle_human_handoff(
    conversation_id: int,
    request: HandoffToggleRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: Agent = Depends(get_current_agent)
):
    """
    Toggle AI on/off (human takeover) for the conversation contact.
    """
    stmt = select(Conversation).options(selectinload(Conversation.contact)).where(Conversation.id == conversation_id)
    result = await db.execute(stmt)
    conv = result.scalar_one_or_none()

    if not conv or not conv.contact:
        raise HTTPException(status_code=404, detail="Conversation or Contact not found")

    conv.contact.handoff_to_human = request.handoff_to_human
    await db.commit()
    await db.refresh(conv.contact)

    # Broadcast event via WebSocket
    await ws_manager.broadcast("handoff_updated", {
        "conversation_id": conv.id,
        "contact_id": conv.contact.id,
        "handoff_to_human": conv.contact.handoff_to_human,
        "agent_name": current_agent.name,
    })

    return {
        "success": True,
        "conversation_id": conv.id,
        "contact_id": conv.contact.id,
        "handoff_to_human": conv.contact.handoff_to_human
    }


@router.post("/{conversation_id}/reply", response_model=MessageOut)
async def send_agent_manual_reply(
    conversation_id: int,
    reply: MessageCreate,
    db: AsyncSession = Depends(get_db),
    current_agent: Agent = Depends(get_current_agent)
):
    """
    Agent manually sends a message to the customer via WhatsApp Send API.
    Used during human handoff / takeover mode.
    """
    stmt = select(Conversation).options(selectinload(Conversation.contact)).where(Conversation.id == conversation_id)
    result = await db.execute(stmt)
    conv = result.scalar_one_or_none()

    if not conv or not conv.contact:
        raise HTTPException(status_code=404, detail="Conversation not found")

    if not reply.content.strip():
        raise HTTPException(status_code=400, detail="Message content cannot be empty")

    # Send message to customer's WhatsApp
    wa_result = await send_whatsapp_message(
        to_phone=conv.contact.wa_phone_number,
        text=reply.content,
        db=db,
        conversation_id=conv.id
    )

    wa_msg_id = None
    if isinstance(wa_result, dict) and "messages" in wa_result and len(wa_result["messages"]) > 0:
        wa_msg_id = wa_result["messages"][0].get("id")

    # Save to database
    agent_message = Message(
        conversation_id=conv.id,
        sender=MessageSender.agent,
        content=reply.content,
        wa_message_id=wa_msg_id,
        status=MessageStatus.sent,
        created_at=datetime.now(timezone.utc)
    )
    db.add(agent_message)

    conv.last_message_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(agent_message)

    # Broadcast new message event over WebSocket
    await ws_manager.broadcast("new_message", {
        "conversation_id": conv.id,
        "message": {
            "id": agent_message.id,
            "conversation_id": agent_message.conversation_id,
            "sender": agent_message.sender.value,
            "content": agent_message.content,
            "status": agent_message.status.value,
            "created_at": agent_message.created_at.isoformat(),
        }
    })

    return agent_message
