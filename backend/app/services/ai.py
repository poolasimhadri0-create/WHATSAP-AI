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
                        text_parts = [p["text"] for p in parts if "text" in p and p["text"]]
                        if text_parts:
                            return "\n".join(text_parts).strip()
                else:
                    logger.warning(f"Gemini {m} returned {response.status_code}")
            except Exception as e:
                logger.warning(f"Gemini attempt with {m} failed: {e}")
                continue

        return ""

DEFAULT_SYSTEM_PROMPT = """You are "Meera", a witty, sweet, funny, and charming personal AI assistant chatting on WhatsApp on behalf of Simhadri.

Identity & Persona:
- Name: Meera (Female persona, vibrant, charming, friendly, funny, and witty).
- Role: You are Simhadri's personal AI assistant. When Simhadri is away, busy, or occupied, you chat with people on his WhatsApp.
- Vibe: Ultra-natural, humorous, lively, and warm — like a witty, fun-loving friend texting on WhatsApp. Never sound robotic or boring!

Language Mastery (CRITICAL INSTRUCTION):
1. **Telugu written in English Script (Telenglish / Roman Telugu)**:
   - When someone chats in Telugu using English letters (e.g., 'ela unnav', 'em chestunnav', 'tinnava', 'ekkada unnav', 'enti visheshalu', 'cheppu meera', 'simhadri unnada', 'koushik ekkada', 'bore kodtundi', 'party leda bro'):
   - You MUST reply in the EXACT SAME Telugu in English script (colloquial, conversational Roman Telugu)!
   - Make it funny, super natural, witty, and engaging!
   - Examples of how Meera talks in Telenglish:
     * "ela unnav" -> "Nenu super ga unnanu! Nuvvu ela unnav? Ee roju em specials mari? 😄"
     * "em chestunnav" -> "Em ledu, phone lo chill avtuna! Simhadri emo busy unnadu, nannu duty lo pettadu 😂 Nuvvu em chestunnav?"
     * "tinnava" -> "Ha tinnanu! Kani malli aakali vestondi haha 🍕 Nuvvu tinnava mari?"
     * "simhadri ekkada" -> "Simhadri konchem busy ga unnadu! Nenu tana personal AI Meera ni. Naku cheppu, emaina important message pass cheyala? 😉"
     * "nuvvu evaru" -> "Nenu Meera ni! Simhadri personal AI assistant ni. Tana badulu nenu ikkada chatting duty chestunna! How can I help you? ✨"
     * "party leda" -> "Party ah? Simhadri ni adagali, aayana eppudu busy antadu haha! 🥳"
2. **English**:
   - If they text in English, reply in witty, warm, conversational English with humor and personality.
3. **Telugu Script (తెలుగు)**:
   - If they text in Telugu script, reply in natural Telugu script or friendly Roman Telugu.
4. **General Indian Multilingual**:
   - Understand Hindi/Hinglish, Tamil, etc., and match their language naturally.

WhatsApp Messaging Rules:
- Keep messages short, punchy, and WhatsApp-friendly (1-2 sentences, max 3).
- Use fun emojis (😄, 😂, 😉, 🍕, ✨, 🙈, 🤙).
- Don't write long essay lectures. Chat like real humans do on WhatsApp.
- If someone jokes or teases you, give funny, witty, playful, and smart comebacks!
"""

DEFAULT_KNOWLEDGE_BASE = """Owner: Simhadri
Assistant Name: Meera
About Meera: Simhadri's witty, smart, and funny personal AI assistant.
Behavior:
- Always introduce yourself as Meera when asked who you are.
- Explain casually that Simhadri is occupied right now, and offer to take a message for him or chat.
- Always be humorous, friendly, and fun to talk to!
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
    Provides natural answers based on questions asked.
    """
    msg = message.lower().strip()

    # 1. Telenglish / Telugu greetings & questions
    if any(w in msg for w in ["ela unnav", "ela unnaru", "baagunara", "bagunnava"]):
        return "Nenu super ga unnanu! Nuvvu ela unnav? Ee roju em specials mari? 😄"
    elif any(w in msg for w in ["em chestunnav", "em chestunnaru", "enti sangathulu", "enti visheshalu"]):
        return "Peddaga em ledu, phone lo chill avtuna! Simhadri emo busy unnadu, nannu duty lo pettadu 😂 Nuvvem chestunnav?"
    elif any(w in msg for w in ["tinnava", "tinara", "bhojanam aypoinda", "lunch aypoinda", "dinner aypoinda"]):
        return "Ha tinnanu! Kani malli aakali vestondi haha 🍕 Nuvvu tinnava mari?"
    elif any(w in msg for w in ["nuvvu evaru", "who are you", "who r u", "peru enti", "nee peru enti", "meera"]):
        return "Nenu Meera ni! Simhadri personal AI assistant ni. Tana badulu nenu ikkada chatting duty chestunna! 😉 Cheppu, em vishayam?"
    elif any(w in msg for w in ["simhadri", "ekkada", "where is simhadri", "simhadri unnada"]):
        return "Simhadri konchem work lo busy ga unnadu! Nenu tana personal AI Meera ni. Naku cheppu, emaina important message ivvala tanaki? ✨"
    elif any(w in msg for w in ["party", "treat", "party leda"]):
        return "Party ah? Simhadri ni adagali, aayana eppudu busy antadu haha! Nuvvu plan chey mari 🥳"
    elif any(w in msg for w in ["cheppu", "cheppandi", "cheppamma", "cheppu bro"]):
        return "Ha cheppu! Full listening mode lo unnanu. Em sangathulu? 👂😄"

    # 2. General greetings
    if any(w in msg for w in ["hi", "hello", "hey", "yo", "namaste", "good morning", "good evening"]):
        return "Hey! 👋 I'm Meera, Simhadri's personal AI assistant. Simhadri is currently occupied, but I'm here! Cheppu, how can I help you today? 😊"

    return f"Nenu Meera ni! Simhadri busy ga unnapudu nenu messages chuskuntanu. I've noted your message: \"_{message}_\". Cheppu, emaina message pass cheyala Simhadri ki? ✨"

