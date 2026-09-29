import logging
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import declarative_base
from app.core.config import settings

logger = logging.getLogger(__name__)

Base = declarative_base()

engine = None
async_session_maker = None
_using_sqlite = False


def create_engine_instance(db_url: str):
    if "sqlite" in db_url:
        return create_async_engine(
            db_url,
            echo=False,
            connect_args={"check_same_thread": False},
        )
    else:
        return create_async_engine(
            db_url,
            echo=False,
            pool_pre_ping=True,
            pool_recycle=3600,
        )


def get_engine():
    global engine, async_session_maker
    if engine is None:
        engine = create_engine_instance(settings.DATABASE_URL)
        async_session_maker = async_sessionmaker(
            engine,
            class_=AsyncSession,
            expire_on_commit=False,
        )
    return engine


async def ensure_db_connected():
    """
    Tests the connection. If MySQL connection fails and FALLBACK_TO_SQLITE is true,
    switches engine to SQLite automatically.
    """
    global engine, async_session_maker, _using_sqlite
    get_engine()
    
    try:
        async with engine.begin() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception as e:
        if settings.FALLBACK_TO_SQLITE:
            logger.warning(
                f"[DATABASE WARNING] Primary database connection ({settings.DATABASE_URL}) failed: {e}.\n"
                f"-> Automatically falling back to SQLite ({settings.SQLITE_URL}) for smooth local operation."
            )
            await engine.dispose()
            engine = create_engine_instance(settings.SQLITE_URL)
            async_session_maker = async_sessionmaker(
                engine,
                class_=AsyncSession,
                expire_on_commit=False,
            )
            _using_sqlite = True
        else:
            raise e


def get_session_maker():
    global async_session_maker
    if async_session_maker is None:
        get_engine()
    return async_session_maker


async def get_db():
    await ensure_db_connected()
    maker = get_session_maker()
    async with maker() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
