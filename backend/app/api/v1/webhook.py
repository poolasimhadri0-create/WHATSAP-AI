import json
import logging
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Request, Response, BackgroundTasks, HTTPException, Query, status
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.db.session import get_session_maker
from app.models.contact import Contact
from app.models.conversation import Conversation, ConversationStatus
from app.models.message import Message, MessageSender, MessageStatus
from app.services.whatsapp import verify_meta_signature, send_whatsapp_message
from app.services.ai import generate_llm_reply
from app.services.websocket_manager import ws_manager

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/whatsapp")
async def verify_whatsapp_webhook(
    hub_mode: Optional[str] = Query(None, alias="hub.mode"),
    hub_challenge: Optional[str] = Query(None, alias="hub.challenge"),
    hub_verify_token: Optional[str] = Query(None, alias="hub.verify_token"),
):
    """
    Verification handshake for Meta WhatsApp Cloud API.
    Meta sends a GET request with hub.mode, hub.verify_token, and hub.challenge.
    """
    logger.info(f"Webhook verification request: mode={hub_mode}, verify_token={hub_verify_token}")
    if hub_mode == "subscribe" and hub_verify_token == settings.WHATSAPP_VERIFY_TOKEN:
        logger.info("Webhook verification succeeded.")
        return PlainTextResponse(content=hub_challenge or "", status_code=status.HTTP_200_OK)
    
    logger.warning("Webhook verification failed: token mismatch or invalid mode.")
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Verification token mismatch")


async def process_incoming_whatsapp_message(payload_dict: dict):
    """
    Background worker that parses WhatsApp message, updates DB,
    handles handoff checking, invokes AI engine, and sends reply.
    """
    maker = get_session_maker()
    async with maker() as db:
        try:
            entry_list = payload_dict.get("entry", [])
            for entry in entry_list:
                for change in entry.get("changes", []):
                    value = change.get("value", {})
                    
                    # 1. Check for status updates (sent, delivered, read)
                    statuses = value.get("statuses", [])
                    for st in statuses:
                        wa_msg_id = st.get("id")
                        status_str = st.get("status")
                        if wa_msg_id and status_str in ["sent", "delivered", "read", "failed"]:
                            stmt = select(Message).where(Message.wa_message_id == wa_msg_id)
                            res = await db.execute(stmt)
                            msg = res.scalar_one_or_none()
                            if msg:
                                msg.status = MessageStatus(status_str)
                                await db.commit()
                                await ws_manager.broadcast("message_status_updated", {
                                    "message_id": msg.id,
                                    "wa_message_id": wa_msg_id,
                                    "status": status_str,
                                })

                    # 2. Check for incoming messages
                    messages = value.get("messages", [])
                    contacts_info = value.get("contacts", [])
                    
                    # Extract contact profile name if available
                    customer_name = "WhatsApp User"
                    if contacts_info and len(contacts_info) > 0:
                        profile = contacts_info[0].get("profile", {})
                        customer_name = profile.get("name") or customer_name

                    for msg_item in messages:
                        wa_phone_number = msg_item.get("from")
                        wa_message_id = msg_item.get("id")
                        msg_type = msg_item.get("type")
                        
                        # Extract content
                        text_content = ""
                        if msg_type == "text":
                            text_content = msg_item.get("text", {}).get("body", "")
                        elif msg_type == "interactive":
                            # Button reply or list reply
                            interactive = msg_item.get("interactive", {})
                            btn_reply = interactive.get("button_reply", {})
                            list_reply = interactive.get("list_reply", {})
                            text_content = btn_reply.get("title") or list_reply.get("title") or "[Interactive Reply]"
                        else:
                            text_content = f"[{msg_type.capitalize()} message received]"

                        if not wa_phone_number or not text_content:
                            continue

                        # Clean phone number (digits only or with standard format)
                        clean_phone = wa_phone_number.replace("+", "").strip()

                        # Upsert Contact
                        stmt = select(Contact).where(Contact.wa_phone_number == clean_phone)
                        res = await db.execute(stmt)
                        contact = res.scalar_one_or_none()
                        if not contact:
                            contact = Contact(
                                wa_phone_number=clean_phone,
                                name=customer_name,
                                handoff_to_human=False
                            )
                            db.add(contact)
                            await db.flush()
                        else:
                            if customer_name and customer_name != "WhatsApp User" and (not contact.name or contact.name == "WhatsApp User"):
                                contact.name = customer_name

                        # Upsert Active Conversation
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

                        # Save User's Incoming Message
                        user_msg = Message(
                            conversation_id=conversation.id,
                            sender=MessageSender.user,
                            content=text_content,
                            wa_message_id=wa_message_id,
                            status=MessageStatus.delivered,
                            created_at=datetime.now(timezone.utc)
                        )
                        db.add(user_msg)
                        conversation.last_message_at = datetime.now(timezone.utc)
                        await db.commit()
                        await db.refresh(user_msg)

                        # Broadcast user's message to React dashboard over WebSocket
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

                        # Check Human Handoff status
                        if contact.handoff_to_human:
                            logger.info(f"Handoff is ACTIVE for contact {contact.wa_phone_number}. Suppressing AI reply.")
                            await ws_manager.broadcast("human_attention_needed", {
                                "conversation_id": conversation.id,
                                "contact_name": contact.name,
                                "phone": contact.wa_phone_number,
                                "last_message": text_content
                            })
                            continue

                        # If AI is active, fetch recent messages as context
                        stmt = (
                            select(Message)
                            .where(Message.conversation_id == conversation.id)
                            .order_by(Message.created_at.asc())
                        )
                        res = await db.execute(stmt)
                        history = res.scalars().all()

                        # Call AI Reply Engine
                        ai_reply_text, handoff_triggered = await generate_llm_reply(
                            messages_history=history,
                            user_latest_message=text_content,
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

                        # Send reply to customer via WhatsApp
                        wa_send_res = await send_whatsapp_message(
                            to_phone=contact.wa_phone_number,
                            text=ai_reply_text,
                            db=db,
                            conversation_id=conversation.id
                        )

                        wa_ai_msg_id = None
                        if isinstance(wa_send_res, dict) and "messages" in wa_send_res and len(wa_send_res["messages"]) > 0:
                            wa_ai_msg_id = wa_send_res["messages"][0].get("id")

                        # Save AI Reply to DB
                        ai_msg = Message(
                            conversation_id=conversation.id,
                            sender=MessageSender.ai,
                            content=ai_reply_text,
                            wa_message_id=wa_ai_msg_id,
                            status=MessageStatus.sent,
                            created_at=datetime.now(timezone.utc)
                        )
                        db.add(ai_msg)
                        conversation.last_message_at = datetime.now(timezone.utc)
                        await db.commit()
                        await db.refresh(ai_msg)

                        # Broadcast AI message to connected dashboard clients
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

        except Exception as e:
            logger.error(f"Error in background WhatsApp processor: {e}", exc_info=True)


@router.post("/whatsapp")
async def handle_whatsapp_webhook(
    request: Request,
    background_tasks: BackgroundTasks
):
    """
    Receives incoming WhatsApp Cloud API events (messages, deliveries, receipts).
    Validates Meta HMAC-SHA256 signature and offloads processing to BackgroundTasks
    so FastAPI responds to Meta within milliseconds.
    """
    raw_body = await request.body()
    signature_header = request.headers.get("X-Hub-Signature-256")

    # Verify Meta signature
    if not verify_meta_signature(raw_body, signature_header):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Meta Webhook Signature"
        )

    try:
        payload_dict = json.loads(raw_body.decode("utf-8"))
    except Exception as e:
        logger.error(f"Failed to decode webhook JSON: {e}")
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    # Respond immediately to Meta and handle message processing asynchronously
    background_tasks.add_task(process_incoming_whatsapp_message, payload_dict)
    return {"status": "received"}
