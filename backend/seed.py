import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.db.session import get_session_maker, ensure_db_connected
from app.main import init_db_and_seed
from app.models.contact import Contact
from app.models.conversation import Conversation, ConversationStatus
from app.models.message import Message, MessageSender, MessageStatus
from sqlalchemy import select


async def seed_demo_data():
    await init_db_and_seed()
    maker = get_session_maker()
    async with maker() as db:
        # Check if contacts already exist
        res = await db.execute(select(Contact))
        if res.scalars().first():
            print("Demo contacts already exist. Skipping seed.")
            return

        now = datetime.now(timezone.utc)

        # 1. Contact 1: Sarah Jenkins (Active AI conversation about pricing)
        c1 = Contact(
            wa_phone_number="14155552671",
            name="Sarah Jenkins",
            handoff_to_human=False
        )
        db.add(c1)
        await db.flush()

        conv1 = Conversation(
            contact_id=c1.id,
            status=ConversationStatus.active,
            started_at=now - timedelta(minutes=45),
            last_message_at=now - timedelta(minutes=2)
        )
        db.add(conv1)
        await db.flush()

        m1_1 = Message(
            conversation_id=conv1.id,
            sender=MessageSender.user,
            content="Hi there! Do you offer cloud migration services for small businesses?",
            status=MessageStatus.read,
            created_at=now - timedelta(minutes=45)
        )
        m1_2 = Message(
            conversation_id=conv1.id,
            sender=MessageSender.ai,
            content="Hello Sarah! 👋 Yes, at *NovaCare Solutions*, we provide end-to-end cloud migration tailored specifically for small and mid-sized businesses. What platform are you currently using?",
            status=MessageStatus.delivered,
            created_at=now - timedelta(minutes=44)
        )
        m1_3 = Message(
            conversation_id=conv1.id,
            sender=MessageSender.user,
            content="We have on-prem servers and want to move to AWS. How much is the Pro Plan?",
            status=MessageStatus.read,
            created_at=now - timedelta(minutes=5)
        )
        m1_4 = Message(
            conversation_id=conv1.id,
            sender=MessageSender.ai,
            content="Our *Pro Business Plan* is *$199/month*, which includes complete cloud migration guidance and 24/7 helpdesk support. All plans come with a 30-day money-back guarantee! Would you like to schedule a free assessment?",
            status=MessageStatus.sent,
            created_at=now - timedelta(minutes=2)
        )
        db.add_all([m1_1, m1_2, m1_3, m1_4])

        # 2. Contact 2: David Kim (Human Handoff Triggered - Needs Live Agent)
        c2 = Contact(
            wa_phone_number="12065559812",
            name="David Kim",
            handoff_to_human=True  # Human handoff ACTIVE
        )
        db.add(c2)
        await db.flush()

        conv2 = Conversation(
            contact_id=c2.id,
            status=ConversationStatus.active,
            started_at=now - timedelta(hours=2),
            last_message_at=now - timedelta(minutes=8)
        )
        db.add(conv2)
        await db.flush()

        m2_1 = Message(
            conversation_id=conv2.id,
            sender=MessageSender.user,
            content="I am having billing trouble with my enterprise subscription invoice.",
            status=MessageStatus.read,
            created_at=now - timedelta(minutes=15)
        )
        m2_2 = Message(
            conversation_id=conv2.id,
            sender=MessageSender.user,
            content="Can I speak to a human agent please? This is urgent.",
            status=MessageStatus.read,
            created_at=now - timedelta(minutes=10)
        )
        m2_3 = Message(
            conversation_id=conv2.id,
            sender=MessageSender.ai,
            content="I've paused our automated assistant and connected you with a human support agent. One of our team members will be with you shortly. Thank you for your patience! 👤💬",
            status=MessageStatus.delivered,
            created_at=now - timedelta(minutes=8)
        )
        db.add_all([m2_1, m2_2, m2_3])

        # 3. Contact 3: Elena Rostova (Inquiry about hours and support)
        c3 = Contact(
            wa_phone_number="447700900144",
            name="Elena Rostova",
            handoff_to_human=False
        )
        db.add(c3)
        await db.flush()

        conv3 = Conversation(
            contact_id=c3.id,
            status=ConversationStatus.active,
            started_at=now - timedelta(hours=5),
            last_message_at=now - timedelta(minutes=25)
        )
        db.add(conv3)
        await db.flush()

        m3_1 = Message(
            conversation_id=conv3.id,
            sender=MessageSender.user,
            content="What time does your phone support open on Saturdays?",
            status=MessageStatus.read,
            created_at=now - timedelta(minutes=26)
        )
        m3_2 = Message(
            conversation_id=conv3.id,
            sender=MessageSender.ai,
            content="Our Saturday support hours are 🕒 *10:00 AM – 2:00 PM EST*. During weekdays we are open *9:00 AM – 6:00 PM EST*. Our WhatsApp assistant is available 24/7!",
            status=MessageStatus.delivered,
            created_at=now - timedelta(minutes=25)
        )
        db.add_all([m3_1, m3_2])

        await db.commit()
        print("Demo seed data inserted successfully! 🌟")


if __name__ == "__main__":
    asyncio.run(seed_demo_data())
