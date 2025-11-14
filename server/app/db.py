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

"""
SQLite database for Lem v0.1.

Schema:
- settings(key TEXT PRIMARY KEY, value TEXT)
- device(id TEXT PRIMARY KEY, pubkey TEXT, created_at TIMESTAMP)
- auth(state_json TEXT)

Requirements:
- WAL mode for concurrent reads
- Type-safe operations
- No migrations (single schema for v0.1)
"""

import json
import sqlite3
from collections.abc import Generator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

# Database path: ~/.lem/lem.db
LEM_HOME = Path.home() / ".lem"
DB_PATH = LEM_HOME / "lem.db"


class DatabaseError(Exception):
    """Base exception for database errors."""

    pass


def init_db() -> None:
    """
    Initialize database with v0.1 schema.
    Creates tables if they don't exist and enables WAL mode.
    """
    # Ensure ~/.lem directory exists
    LEM_HOME.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(DB_PATH))
    try:
        # Enable WAL mode for concurrent reads
        conn.execute("PRAGMA journal_mode=WAL")

        # Create tables (idempotent)
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS device (
                id TEXT PRIMARY KEY,
                pubkey TEXT NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS auth (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                state_json TEXT NOT NULL
            );
        """
        )

        conn.commit()
    finally:
        conn.close()


@contextmanager
def get_db() -> Generator[sqlite3.Connection, None, None]:
    """
    Context manager for database connections.
    Ensures connection is closed after use.
    """
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row  # Enable dict-like access
    try:
        yield conn
    finally:
        conn.close()


# ============================================================================
# Settings table operations
# ============================================================================


def get_setting(key: str) -> str | None:
    """
    Get a setting value by key.

    Args:
        key: Setting key

    Returns:
        Setting value or None if not found
    """
    with get_db() as conn:
        cursor = conn.execute("SELECT value FROM settings WHERE key = ?", (key,))
        row = cursor.fetchone()
        return row["value"] if row else None


def set_setting(key: str, value: str) -> None:
    """
    Set a setting value (upsert).

    Args:
        key: Setting key
        value: Setting value
    """
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, value),
        )
        conn.commit()


def delete_setting(key: str) -> None:
    """
    Delete a setting by key.

    Args:
        key: Setting key
    """
    with get_db() as conn:
        conn.execute("DELETE FROM settings WHERE key = ?", (key,))
        conn.commit()


# ============================================================================
# Device table operations
# ============================================================================


class Device:
    """Device record."""

    def __init__(self, id: str, pubkey: str, created_at: datetime):
        self.id = id
        self.pubkey = pubkey
        self.created_at = created_at

    def to_dict(self) -> dict[str, str]:
        """Convert to dictionary."""
        return {
            "id": self.id,
            "pubkey": self.pubkey,
            "created_at": self.created_at.isoformat(),
        }


def get_device() -> Device | None:
    """
    Get the device record (single device in v0.1).

    Returns:
        Device or None if not registered
    """
    with get_db() as conn:
        cursor = conn.execute("SELECT id, pubkey, created_at FROM device LIMIT 1")
        row = cursor.fetchone()
        if not row:
            return None

        return Device(
            id=row["id"],
            pubkey=row["pubkey"],
            created_at=datetime.fromisoformat(row["created_at"]),
        )


def register_device(device_id: str, pubkey: str) -> Device:
    """
    Register this device (insert or replace).

    Args:
        device_id: Unique device ID
        pubkey: Ed25519 public key (hex or base64)

    Returns:
        Device record

    Raises:
        DatabaseError: If registration fails
    """
    try:
        with get_db() as conn:
            # Delete existing device (single device in v0.1)
            conn.execute("DELETE FROM device")

            # Insert new device
            created_at = datetime.utcnow()
            conn.execute(
                "INSERT INTO device (id, pubkey, created_at) VALUES (?, ?, ?)",
                (device_id, pubkey, created_at.isoformat()),
            )
            conn.commit()

            return Device(id=device_id, pubkey=pubkey, created_at=created_at)
    except sqlite3.Error as e:
        raise DatabaseError(f"Failed to register device: {e}") from e


def delete_device() -> None:
    """Delete the device record (unregister)."""
    with get_db() as conn:
        conn.execute("DELETE FROM device")
        conn.commit()


# ============================================================================
# Auth table operations
# ============================================================================


class AuthState:
    """Auth state record for remote access."""

    def __init__(
        self,
        email: str,
        jwt_token: str,
        device_id: str,
        signaling_url: str,
    ) -> None:
        """Initialize auth state.

        Args:
            email: User email address
            jwt_token: JWT access token from signaling server
            device_id: Local server device ID
            signaling_url: Signaling server URL
        """
        self.email = email
        self.jwt_token = jwt_token
        self.device_id = device_id
        self.signaling_url = signaling_url

    def to_dict(self) -> dict[str, str]:
        """Convert to dictionary."""
        return {
            "email": self.email,
            "jwt_token": self.jwt_token,
            "device_id": self.device_id,
            "signaling_url": self.signaling_url,
        }

    def to_json(self) -> str:
        """Convert to JSON string."""
        return json.dumps(self.to_dict())

    @classmethod
    def from_json(cls, json_str: str) -> "AuthState":
        """Create AuthState from JSON string.

        Args:
            json_str: JSON string containing auth state

        Returns:
            AuthState instance
        """
        data = json.loads(json_str)
        return cls(
            email=data["email"],
            jwt_token=data["jwt_token"],
            device_id=data["device_id"],
            signaling_url=data["signaling_url"],
        )


def get_auth_state() -> AuthState | None:
    """
    Get auth state (single row in v0.1).

    Returns:
        AuthState or None if not logged in
    """
    with get_db() as conn:
        cursor = conn.execute("SELECT state_json FROM auth WHERE id = 1")
        row = cursor.fetchone()
        if not row:
            return None

        try:
            return AuthState.from_json(row["state_json"])
        except (json.JSONDecodeError, KeyError):
            # Invalid auth state - delete it
            delete_auth_state()
            return None


def set_auth_state(auth_state: AuthState) -> None:
    """
    Set auth state (upsert).

    Args:
        auth_state: AuthState to store
    """
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO auth (id, state_json) VALUES (1, ?)",
            (auth_state.to_json(),),
        )
        conn.commit()


def delete_auth_state() -> None:
    """Delete auth state (logout)."""
    with get_db() as conn:
        conn.execute("DELETE FROM auth WHERE id = 1")
        conn.commit()
