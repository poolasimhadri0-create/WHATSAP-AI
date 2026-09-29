# Import all the models, so that Base has them before being
# imported by Alembic or runtime initializers
from app.db.session import Base  # noqa
from app.models.contact import Contact  # noqa
from app.models.conversation import Conversation  # noqa
from app.models.message import Message  # noqa
from app.models.bot_config import BotConfig  # noqa
from app.models.agent import Agent  # noqa
from app.models.failed_message import FailedMessage  # noqa
