import time
from pydantic import BaseModel
from typing import Optional
from fastapi import APIRouter, BackgroundTasks
from app.api.v1.webhook import process_incoming_whatsapp_message

router = APIRouter()


class SimulateMessageRequest(BaseModel):
    phone_number: str = "15551234567"
    contact_name: Optional[str] = "Alice Morgan"
    message_text: str = "Hello, what plans and pricing do you offer?"


@router.post("/simulate-message")
async def simulate_incoming_whatsapp_message(
    payload: SimulateMessageRequest,
    background_tasks: BackgroundTasks
):
    """
    Simulates an incoming WhatsApp message payload from Meta's Cloud API.
    Useful for local testing, frontend live chat simulation, and automated validation.
    """
    clean_phone = payload.phone_number.replace("+", "").replace(" ", "").replace("-", "")
    timestamp_str = str(int(time.time()))
    wa_message_id = f"wamid.sim_{int(time.time() * 1000)}"

    simulated_payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "1234567890",
                "changes": [
                    {
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {
                                "display_phone_number": "15550009999",
                                "phone_number_id": "1234567890"
                            },
                            "contacts": [
                                {
                                    "profile": {
                                        "name": payload.contact_name or "WhatsApp User"
                                    },
                                    "wa_id": clean_phone
                                }
                            ],
                            "messages": [
                                {
                                    "from": clean_phone,
                                    "id": wa_message_id,
                                    "timestamp": timestamp_str,
                                    "text": {
                                        "body": payload.message_text
                                    },
                                    "type": "text"
                                }
                            ]
                        },
                        "field": "messages"
                    }
                ]
            }
        ]
    }

    # Offload processing through the same background pipeline
    background_tasks.add_task(process_incoming_whatsapp_message, simulated_payload)

    return {
        "success": True,
        "message": "Simulated WhatsApp message enqueued for processing",
        "phone_number": clean_phone,
        "text": payload.message_text
    }
