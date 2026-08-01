# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2025 Lem
#
# This file is part of Lem.
#
# Lem is free software: you can redistribute it and/or modify it under
# the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# Lem is distributed in the hope that it will be useful, but WITHOUT
# ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
# or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General
# Public License for more details.

"""Database initialization and connection management.

Supports both SQLite (local development) and PostgreSQL (Docker/AWS).
Set DATABASE_URL environment variable to use PostgreSQL.
"""

import os
from collections.abc import AsyncGenerator, Iterable
from typing import Any, Protocol

import aiosqlite

# Database configuration
DATABASE_URL = os.environ.get("DATABASE_URL", "")
USE_POSTGRES = DATABASE_URL.startswith("postgresql")

# SQLite database file, used when DATABASE_URL is not a PostgreSQL URL.
# Read at call time so tests can point it at a temporary directory.
DATABASE_FILE = os.environ.get("SQLITE_DB_FILE", "signaling.db")

# PostgreSQL connection pool (lazy initialized)
_pg_pool: Any = None


class DBRow(Protocol):
    """A database row supporting column access by name.

    Implemented by both ``sqlite3.Row`` and ``asyncpg.Record``.
    """

    def __getitem__(self, key: str, /) -> Any: ...


class PostgresConnection(Protocol):
    """The subset of ``asyncpg.Connection`` this application uses.

    asyncpg ships no type information, so the API surface is declared here
    instead of leaking ``Any`` into the endpoints.
    """

    async def fetchrow(self, query: str, /, *args: Any) -> DBRow | None: ...

    async def fetch(self, query: str, /, *args: Any) -> Iterable[DBRow]: ...

    async def execute(self, query: str, /, *args: Any) -> str: ...


# A connection from either backend. Endpoints branch on USE_POSTGRES and
# narrow with as_postgres()/as_sqlite() below.
DBConnection = aiosqlite.Connection | PostgresConnection


def as_sqlite(db: DBConnection) -> aiosqlite.Connection:
    """Narrow a connection to the SQLite backend.

    Args:
        db: Connection yielded by get_db().

    Returns:
        The connection as an aiosqlite connection.

    Raises:
        TypeError: If the active backend is not SQLite.
    """
    if not isinstance(db, aiosqlite.Connection):
        raise TypeError("Expected a SQLite connection")
    return db


def as_postgres(db: DBConnection) -> PostgresConnection:
    """Narrow a connection to the PostgreSQL backend.

    Args:
        db: Connection yielded by get_db().

    Returns:
        The connection as a PostgreSQL connection.

    Raises:
        TypeError: If the active backend is not PostgreSQL.
    """
    if isinstance(db, aiosqlite.Connection):
        raise TypeError("Expected a PostgreSQL connection")
    return db


def _parse_postgres_url(url: str) -> dict[str, Any]:
    """Parse PostgreSQL URL into connection parameters.

    Args:
        url: PostgreSQL connection URL.

    Returns:
        Dictionary of connection parameters.
    """
    # Handle both postgresql:// and postgresql+asyncpg://
    url = url.replace("postgresql+asyncpg://", "postgresql://")

    from urllib.parse import parse_qs, urlparse
    parsed = urlparse(url)

    params: dict[str, Any] = {
        "user": parsed.username,
        "password": parsed.password,
        "host": parsed.hostname,
        "port": parsed.port or 5432,
        "database": parsed.path.lstrip("/"),
    }

    # Handle SSL mode from query string
    query_params = parse_qs(parsed.query)
    if "sslmode" in query_params:
        sslmode = query_params["sslmode"][0]
        if sslmode in ("require", "verify-ca", "verify-full"):
            params["ssl"] = "require"

    return params


async def _get_pg_pool() -> Any:
    """Get or create PostgreSQL connection pool."""
    global _pg_pool
    if _pg_pool is None:
        import asyncpg
        params = _parse_postgres_url(DATABASE_URL)
        _pg_pool = await asyncpg.create_pool(**params, min_size=2, max_size=10)
    return _pg_pool


async def get_db() -> AsyncGenerator[DBConnection, None]:
    """Get database connection.

    Declared as an AsyncGenerator rather than an AsyncIterator so callers
    outside FastAPI's dependency system can drive it directly and call
    aclose() to hand the connection back to the pool.

    Yields:
        Database connection (aiosqlite.Connection or asyncpg.Connection).
    """
    if USE_POSTGRES:
        pool = await _get_pg_pool()
        async with pool.acquire() as conn:
            pg_conn: PostgresConnection = conn
            yield pg_conn
    else:
        async with aiosqlite.connect(DATABASE_FILE) as db:
            db.row_factory = aiosqlite.Row
            yield db


async def init_db() -> None:
    """Initialize the database with required tables."""
    import logging
    logger = logging.getLogger(__name__)

    if USE_POSTGRES:
        logger.info(f"Initializing PostgreSQL database: {DATABASE_URL[:50]}...")
        await _init_postgres()
        logger.info("PostgreSQL tables created successfully")
    else:
        logger.info(f"Initializing SQLite database: {DATABASE_FILE}")
        await _init_sqlite()
        logger.info("SQLite tables created successfully")


async def _init_sqlite() -> None:
    """Initialize SQLite database."""
    async with aiosqlite.connect(DATABASE_FILE) as db:
        # Users table
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                hashed_password TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        # Devices table
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                pubkey TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
            """
        )

        # Create index on user_id for faster lookups
        await db.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_devices_user_id
            ON devices(user_id)
            """
        )

        await db.commit()


async def _init_postgres() -> None:
    """Initialize PostgreSQL database."""
    pool = await _get_pg_pool()
    async with pool.acquire() as conn:
        # Users table (PostgreSQL syntax)
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                hashed_password TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        # Devices table
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                pubkey TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        # Create index on user_id for faster lookups
        await conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_devices_user_id
            ON devices(user_id)
            """
        )


async def close_db() -> None:
    """Close database connections."""
    global _pg_pool
    if _pg_pool is not None:
        await _pg_pool.close()
        _pg_pool = None
