import re
import random
import asyncio
import logging
from typing import List, Dict, Tuple, Optional
import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.config import settings
from app.models.bot_config import BotConfig
from app.models.message import Message, MessageSender

logger = logging.getLogger(__name__)


async def call_gemini_api(
    api_key: str,
    model: str,
    system_instruction: str,
    chat_context: List[Dict[str, str]],
) -> str:
    """
    Calls Google Gemini REST API directly with ultra-low latency (< 1s).
    Automatically tries current flash models if one is busy.
    """
    # Clean model name candidates
    candidate_models = [
        model.replace("models/", "") if model else "gemini-3.1-flash-lite",
        "gemini-3.1-flash-lite",
        "gemini-3.5-flash",
        "gemini-flash-latest",
    ]

    # Format multi-turn contents for Gemini
    contents = []
    for msg in chat_context:
        role = "model" if msg["role"] == "assistant" else "user"
        contents.append({
            "role": role,
            "parts": [{"text": msg["content"]}]
        })

    payload = {
        "system_instruction": {
            "parts": [{"text": system_instruction}]
        },
        "contents": contents,
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 300,
        }
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        for m in candidate_models:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={api_key}"
            try:
                response = await client.post(url, json=payload)
                if response.status_code == 200:
                    data = response.json()
                    candidates = data.get("candidates", [])
                    if candidates and "content" in candidates[0]:
                        parts = candidates[0]["content"].get("parts", [])
                        if parts and "text" in parts[0]:
                            return parts[0]["text"]
                else:
                    logger.warning(f"Gemini {m} returned {response.status_code}")
            except Exception as e:
                logger.warning(f"Gemini attempt with {m} failed: {e}")
                continue

    return ""

DEFAULT_SYSTEM_PROMPT = """You are a smart, friendly, and natural personal AI assistant chatting on WhatsApp.
Tone: Warm, conversational, human, and friendly — like a close friend or helpful assistant texting on WhatsApp.
Language & Style: Always match the EXACT language, script, slang, and dialect of the person messaging you:
- If they text in Tanglish / Tamil (e.g., 'saaptiya', 'enna da', 'machan', 'saptanum'), reply naturally in Tanglish with a friendly, witty vibe!
- If they text in English, reply in natural English.
- If they text in Hindi / Hinglish / Telugu, match their language.
Format: Keep replies short and punchy (1-2 sentences maximum, like real WhatsApp messages). Use suitable emojis 😊.
Never sound robotic or overly corporate unless asked formal business questions.
"""

DEFAULT_KNOWLEDGE_BASE = """Owner: Simhadri
Identity: Personal AI assistant chatting on behalf of Simhadri when he is busy or away.
Behavior: Warm, friendly, casual, and helpful. If friends ask if this is Simhadri, explain casually that you are his personal AI assistant replying while he's momentarily away from his phone, and ask how you can help or take a message for him.
"""

DEFAULT_TRIGGER_KEYWORDS = [
    "talk to a human",
    "talk to human",
    "human agent",
    "agent",
    "representative",
    "speak to someone",
    "speak with someone",
    "real person",
    "customer service rep",
    "complaint",
    "manager",
    "supervisor",
    "operator",
    "human please",
    "help from a person"
]


def format_for_whatsapp(text: str) -> str:
    """
    Strips Markdown features that WhatsApp does not support (headers, links, HTML)
    and maps standard markdown bold/italic to WhatsApp formatting:
    - **bold** -> *bold*
    - *italic* or _italic_ -> _italic_
    - ~~strike~~ -> ~strike~
    """
    if not text:
        return ""

    # Replace markdown headings (###, ##, #) with bold text
    text = re.sub(r"^#{1,6}\s*(.+)$", r"*\1*", text, flags=re.MULTILINE)

    # Convert markdown links [title](url) -> title (url)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 (\2)", text)

    # Convert **bold** to *bold* (WhatsApp style)
    text = re.sub(r"\*\*([^*]+)\*\*", r"*\1*", text)

    # Convert ~~strikethrough~~ to ~strikethrough~
    text = re.sub(r"~~([^~]+)~~", r"~\1~", text)

    # Remove code blocks ```code``` if any, keep content
    text = re.sub(r"```(?:\w+)?\n?", "", text)

    # Remove extra excessive blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text.strip()


async def get_bot_configuration(db: AsyncSession) -> Dict[str, str]:
    """Fetches all configuration parameters from bot_config table."""
    try:
        stmt = select(BotConfig)
        result = await db.execute(stmt)
        configs = result.scalars().all()
        config_dict = {c.key: c.value for c in configs}
    except Exception as e:
        logger.warning(f"Error reading bot_config table: {e}. Using defaults.")
        config_dict = {}

    return {
        "system_prompt": config_dict.get("system_prompt", DEFAULT_SYSTEM_PROMPT),
        "knowledge_base": config_dict.get("knowledge_base", DEFAULT_KNOWLEDGE_BASE),
        "trigger_keywords": config_dict.get("trigger_keywords", ", ".join(DEFAULT_TRIGGER_KEYWORDS)),
        "business_name": config_dict.get("business_name", "NovaCare Solutions"),
        "business_hours": config_dict.get("business_hours", "Mon-Fri 9AM-6PM EST"),
        "greeting_message": config_dict.get("greeting_message", "Hello! Welcome to NovaCare Solutions. How can I help you today?"),
        "model_name": config_dict.get("model_name", settings.LLM_MODEL),
    }


def check_for_human_handoff_trigger(user_message: str, trigger_keywords_str: str) -> bool:
    """
    Checks if incoming user message contains trigger keywords
    requesting a human agent or expressing urgent complaint.
    """
    lower_msg = user_message.lower()
    keywords = [k.strip().lower() for k in trigger_keywords_str.split(",") if k.strip()]
    for kw in keywords:
        # Check phrase match or regex word boundary
        pattern = r"\b" + re.escape(kw) + r"\b"
        if re.search(pattern, lower_msg):
            return True
    return False


async def simulate_human_typing_delay(reply_length: int):
    """
    Simulates human typing delay (1.0 to 2.5 seconds) based on reply length
    so replies don't feel instantaneous or robotic.
    """
    if not settings.TYPING_DELAY_ENABLED:
        return
    # Base delay plus length scale
    delay = min(settings.TYPING_DELAY_MAX_SEC, max(settings.TYPING_DELAY_MIN_SEC, reply_length / 100.0))
    # Add slight random jitter
    delay += random.uniform(0.1, 0.4)
    await asyncio.sleep(delay)


async def generate_llm_reply(
    messages_history: List[Message],
    user_latest_message: str,
    db: AsyncSession
) -> Tuple[str, bool]:
    """
    Main AI engine function:
    1. Checks for handoff triggers. If found, returns handoff notice + True.
    2. Builds system prompt + business knowledge + last 10-15 messages context.
    3. Calls LLM API (OpenAI or Anthropic or fallback mock).
    4. Formats WhatsApp text, applies typing delay simulation.
    Returns: (reply_text, handoff_triggered)
    """
    bot_config = await get_bot_configuration(db)

    # 1. Guardrail: Check for human handoff trigger
    if check_for_human_handoff_trigger(user_latest_message, bot_config["trigger_keywords"]):
        handoff_reply = (
            "I've paused our automated assistant and connected you with a human support agent. "
            "One of our team members will be with you shortly. Thank you for your patience! 👤💬"
        )
        return handoff_reply, True

    # 2. Build Context
    system_content = f"{bot_config['system_prompt']}\n\nBUSINESS KNOWLEDGE BASE:\n{bot_config['knowledge_base']}"

    # Prepare chat history (last 12 messages)
    chat_context = []
    # Take the last 12 messages before the current one
    recent_messages = messages_history[-12:] if len(messages_history) > 12 else messages_history
    for m in recent_messages:
        role = "user" if m.sender == MessageSender.user else "assistant"
        chat_context.append({"role": role, "content": m.content})

    # Append current message if not already the last one
    if not chat_context or chat_context[-1]["content"] != user_latest_message:
        chat_context.append({"role": "user", "content": user_latest_message})

    # 3. Call LLM
    raw_reply = ""
    llm_provider = settings.LLM_PROVIDER.lower()

    # Prioritize Gemini if provider is gemini or if GEMINI_API_KEY is present
    if (llm_provider == "gemini" or not raw_reply) and settings.GEMINI_API_KEY:
        try:
            model_to_use = bot_config.get("model_name", "")
            if not model_to_use or not model_to_use.startswith("gemini"):
                model_to_use = settings.LLM_MODEL or "gemini-3.1-flash-lite"
            raw_reply = await call_gemini_api(
                api_key=settings.GEMINI_API_KEY,
                model=model_to_use,
                system_instruction=system_content,
                chat_context=chat_context,
            )
        except Exception as e:
            logger.error(f"Gemini API call failed: {e}")

    if not raw_reply and llm_provider == "openai" and settings.OPENAI_API_KEY:
        try:
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
            openai_msgs = [{"role": "system", "content": system_content}] + chat_context
            response = await client.chat.completions.create(
                model=bot_config.get("model_name", "gpt-4o-mini"),
                messages=openai_msgs,
                max_tokens=350,
                temperature=0.7,
            )
            raw_reply = response.choices[0].message.content or ""
        except Exception as e:
            logger.error(f"OpenAI call failed: {e}")

    elif not raw_reply and llm_provider == "anthropic" and settings.ANTHROPIC_API_KEY:
        try:
            from anthropic import AsyncAnthropic
            client = AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
            response = await client.messages.create(
                model="claude-3-haiku-20240307",
                system=system_content,
                messages=chat_context,
                max_tokens=350,
                temperature=0.7,
            )
            raw_reply = response.content[0].text if response.content else ""
        except Exception as e:
            logger.error(f"Anthropic call failed: {e}")

    # Fallback Smart Engine if no API key is provided or if API call failed
    if not raw_reply:
        logger.info("Using smart context-aware local reply generator (no API key configured or API error)")
        raw_reply = generate_smart_fallback_reply(user_latest_message, bot_config)

    # 4. Format for WhatsApp
    formatted_reply = format_for_whatsapp(raw_reply)

    # 5. Simulate human typing delay
    await simulate_human_typing_delay(len(formatted_reply))

    return formatted_reply, False


def generate_smart_fallback_reply(message: str, bot_config: Dict[str, str]) -> str:
    """
    Intelligent offline generator for instant local testing and out-of-the-box demoing.
    Provides natural customer service answers based on questions asked.
    """
    msg = message.lower()
    business_name = bot_config.get("business_name", "NovaCare Solutions")

    if any(w in msg for w in ["hi", "hello", "hey", "good morning", "good evening", "start"]):
        return (
            f"Hello! 👋 Welcome to *{business_name}*.\n\n"
            f"I am your assistant. How can I help you today? You can ask about our *services*, *pricing*, *business hours*, or request a human agent at any time!"
        )
    elif any(w in msg for w in ["price", "cost", "pricing", "plans", "rate"]):
        return (
            f"Here are our current plans at *{business_name}*:\n"
            f"• *Starter Plan*: $49/mo (Essential support & setup)\n"
            f"• *Pro Business Plan*: $199/mo (Full migration & 24/7 helpdesk)\n"
            f"• *Enterprise*: Tailored quotation for high-volume needs\n\n"
            f"All plans include a 30-day money-back guarantee. Would you like more details on any plan?"
        )
    elif any(w in msg for w in ["hour", "time", "open", "available", "schedule"]):
        return (
            f"Our business hours are:\n"
            f"🕒 *Monday – Friday*: 9:00 AM – 6:00 PM EST\n"
            f"🕒 *Saturday*: 10:00 AM – 2:00 PM EST\n"
            f"🕒 *Sunday*: Closed\n\n"
            f"Our automated assistant is available 24/7 to assist you!"
        )
    elif any(w in msg for w in ["service", "what do you do", "features", "offer"]):
        return (
            f"At *{business_name}*, we specialize in:\n"
            f"1. *Professional IT Support & Maintenance*\n"
            f"2. *Cloud Migration & Architecture*\n"
            f"3. *Custom Software & API Development*\n"
            f"4. *24/7 Managed Helpdesk*\n\n"
            f"Let me know which service you are interested in!"
        )
    elif any(w in msg for w in ["location", "address", "where", "office"]):
        return f"📍 Our main office is located at *100 Innovation Way, Suite 400, Tech City, USA*. You can also reach us online anytime!"
    elif any(w in msg for w in ["contact", "email", "phone", "call"]):
        return f"You can reach our team at 📧 *support@novacare.example.com* or call our hotline at 📞 *+1 (800) 555-0199*."
    else:
        return (
            f"Thank you for contacting *{business_name}*!\n\n"
            f"I have received your inquiry: \"_{message}_\". "
            f"Could you please specify how we can best assist you with our services or account support? You can also type *'agent'* to speak with our support team."
        )
