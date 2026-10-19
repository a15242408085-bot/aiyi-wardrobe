"""PostgreSQL types with JSON storage for the opt-in SQLite development database.

PostgreSQL dialects retain their original ARRAY/JSONB types and operators. SQLite
is used only for local framework development; it is not a migration target.
"""

from sqlalchemy import JSON
from sqlalchemy.dialects.postgresql import ARRAY as PG_ARRAY
from sqlalchemy.dialects.postgresql import JSONB as PG_JSONB
from sqlalchemy.dialects.postgresql import UUID

JSONB = PG_JSONB().with_variant(JSON(), "sqlite")


def ARRAY(item_type, *args, **kwargs):
    return PG_ARRAY(item_type, *args, **kwargs).with_variant(JSON(), "sqlite")


__all__ = ["ARRAY", "JSONB", "UUID"]
