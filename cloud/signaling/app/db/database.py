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
from collections.abc import AsyncIterator
from typing import Any

import aiosqlite

# Database configuration
DATABASE_URL = os.environ.get("DATABASE_URL", "")
USE_POSTGRES = DATABASE_URL.startswith("postgresql")

# PostgreSQL connection pool (lazy initialized)
_pg_pool: Any = None


def _parse_postgres_url(url: str) -> dict[str, Any]:
    """Parse PostgreSQL URL into connection parameters.

    Args:
        url: PostgreSQL connection URL.

    Returns:
        Dictionary of connection parameters.
    """
    # Handle both postgresql:// and postgresql+asyncpg://
    url = url.replace("postgresql+asyncpg://", "postgresql://")

    from urllib.parse import urlparse
    parsed = urlparse(url)

    return {
        "user": parsed.username,
        "password": parsed.password,
        "host": parsed.hostname,
        "port": parsed.port or 5432,
        "database": parsed.path.lstrip("/"),
    }


async def _get_pg_pool() -> Any:
    """Get or create PostgreSQL connection pool."""
    global _pg_pool
    if _pg_pool is None:
        import asyncpg
        params = _parse_postgres_url(DATABASE_URL)
        _pg_pool = await asyncpg.create_pool(**params, min_size=2, max_size=10)
    return _pg_pool


async def get_db() -> AsyncIterator[Any]:
    """Get database connection.

    Yields:
        Database connection (aiosqlite.Connection or asyncpg.Connection).
    """
    if USE_POSTGRES:
        pool = await _get_pg_pool()
        async with pool.acquire() as conn:
            yield conn
    else:
        async with aiosqlite.connect("signaling.db") as db:
            db.row_factory = aiosqlite.Row
            yield db


async def init_db() -> None:
    """Initialize the database with required tables."""
    if USE_POSTGRES:
        await _init_postgres()
    else:
        await _init_sqlite()


async def _init_sqlite() -> None:
    """Initialize SQLite database."""
    async with aiosqlite.connect("signaling.db") as db:
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
