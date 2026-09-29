from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, DateTime
from sqlalchemy.orm import relationship
from app.db.session import Base


class Contact(Base):
    __tablename__ = "contacts"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    wa_phone_number = Column(String(64), unique=True, index=True, nullable=False)
    name = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    is_blocked = Column(Boolean, default=False, nullable=False)
    handoff_to_human = Column(Boolean, default=False, nullable=False)

    conversations = relationship("Conversation", back_populates="contact", cascade="all, delete-orphan")
