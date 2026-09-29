import enum
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, Enum
from sqlalchemy.orm import relationship
from app.db.session import Base


class MessageSender(str, enum.Enum):
    user = "user"
    ai = "ai"
    agent = "agent"


class MessageStatus(str, enum.Enum):
    sent = "sent"
    delivered = "delivered"
    read = "read"
    failed = "failed"


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    sender = Column(Enum(MessageSender, native_enum=False), nullable=False)
    content = Column(Text, nullable=False)
    wa_message_id = Column(String(255), nullable=True, index=True)
    status = Column(Enum(MessageStatus, native_enum=False), default=MessageStatus.sent, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False, index=True)

    conversation = relationship("Conversation", back_populates="messages")
