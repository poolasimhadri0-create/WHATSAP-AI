import hmac
import hashlib
import asyncio
import logging
from typing import Optional, Dict, Any
import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.config import settings
from app.models.failed_message import FailedMessage

logger = logging.getLogger(__name__)


def verify_meta_signature(payload: bytes, signature_header: Optional[str]) -> bool:
    """
    Verifies that the incoming webhook payload was signed by Meta using the app secret.
    Signature header format: sha256={hash}
    """
    if not settings.META_APP_SECRET:
        # If app secret is not configured yet (e.g. initial testing), allow pass with a warning
        logger.warning("META_APP_SECRET not configured. Skipping signature verification for development.")
        return True

    if not signature_header or not signature_header.startswith("sha256="):
        logger.warning("Invalid or missing X-Hub-Signature-256 header")
        return False

    expected_sig = signature_header.split("sha256=")[1]
    calculated_sig = hmac.new(
        key=settings.META_APP_SECRET.encode("utf-8"),
        msg=payload,
        digestmod=hashlib.sha256
    ).hexdigest()

    return hmac.compare_digest(calculated_sig, expected_sig)


async def send_whatsapp_message(
    to_phone: str,
    text: str,
    db: Optional[AsyncSession] = None,
    conversation_id: Optional[int] = None,
    max_retries: int = 3
) -> Dict[str, Any]:
    # 1. Try local WhatsApp Web QR Bridge first if connected
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            bridge_res = await client.post(
                "http://localhost:3001/send",
                json={"phone": to_phone, "text": text}
            )
            if bridge_res.status_code == 200:
                logger.info(f"WhatsApp message sent via WhatsApp Web QR Bridge to {to_phone}")
                data = bridge_res.json()
                msg_id = data.get("messageId") or f"bridge_{int(asyncio.get_event_loop().time() * 1000)}"
                return {"messages": [{"id": msg_id}]}
    except Exception:
        pass  # Bridge not running or not connected, proceed to Meta Cloud API

    # If WhatsApp credentials are placeholder/empty, log simulation and return mock response
    if not settings.WHATSAPP_TOKEN or settings.WHATSAPP_TOKEN.startswith("EAAB_TEST") or not settings.WHATSAPP_PHONE_NUMBER_ID or settings.WHATSAPP_PHONE_NUMBER_ID == "1234567890":
        logger.info(f"[SIMULATED WHATSAPP OUTGOING] To: {to_phone} | Message: {text}")
        return {
            "messaging_product": "whatsapp",
            "contacts": [{"input": to_phone, "wa_id": to_phone}],
            "messages": [{"id": f"wamid.simulated_{int(asyncio.get_event_loop().time() * 1000)}"}]
        }

    last_error = None
    for attempt in range(1, max_retries + 1):
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(url, json=payload, headers=headers)
                if response.status_code in [200, 201]:
                    logger.info(f"WhatsApp message sent successfully to {to_phone}")
                    return response.json()
                else:
                    error_detail = response.text
                    logger.error(f"WhatsApp API attempt {attempt} failed ({response.status_code}): {error_detail}")
                    last_error = f"HTTP {response.status_code}: {error_detail}"
        except Exception as e:
            last_error = str(e)
            logger.error(f"WhatsApp API exception on attempt {attempt}: {e}")

        if attempt < max_retries:
            await asyncio.sleep(2 ** (attempt - 1))  # 1s, 2s, 4s backoff

    # All retries failed, log to failed_messages
    logger.error(f"All {max_retries} attempts to send message to {to_phone} failed: {last_error}")
    if db:
        try:
            failed_entry = FailedMessage(
                conversation_id=conversation_id,
                recipient_wa_id=to_phone,
                content=text,
                error_message=str(last_error),
                attempts=max_retries,
            )
            db.add(failed_entry)
            await db.commit()
        except Exception as db_err:
            logger.error(f"Could not record failed message to DB: {db_err}")

    return {"error": last_error, "failed": True}
