from collections.abc import AsyncGenerator
from typing import Annotated
from uuid import uuid4

from fastapi import Depends
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings

settings = get_settings()

# Create async engine
engine_options = {"echo": settings.database_echo, "pool_pre_ping": True}
if not settings.local_development:
    engine_options.update(pool_size=5, max_overflow=10)
engine = create_async_engine(str(settings.database_url), **engine_options)

if settings.local_development:
    @event.listens_for(engine.sync_engine, "connect")
    def configure_sqlite(connection, _record):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()
        connection.create_function("gen_random_uuid", 0, lambda: uuid4().hex)
        connection.create_function("greatest", -1, lambda *values: max(v for v in values if v is not None))

# Create session factory
async_session_maker = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)


class Base(DeclarativeBase):
    """Base class for all database models."""

    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Dependency that provides a database session."""
    async with async_session_maker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


# scope="function" so that the commit runs before the response is sent: with the default
# request scope a client could act on a 200 before its writes are visible, and a failed
# commit could no longer turn that 200 into an error.
DbSession = Annotated[AsyncSession, Depends(get_db, scope="function")]
