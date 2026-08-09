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
- device(id TEXT PRIMARY KEY, pubkey TEXT, privkey TEXT, created_at TIMESTAMP)
- auth(state_json TEXT)

Requirements:
- WAL mode for concurrent reads
- Type-safe operations
- No migrations (single schema for v0.1)
"""

import json
import logging
import sqlite3
from collections.abc import Generator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from app.config import platform as platform_config

logger = logging.getLogger(__name__)

# app.config.platform is the single place the install prefix is resolved. A
# second Path.home() / ".lem" here is how a relocated install ended up putting
# its database and API token back in the default directory, out of reach of the
# uninstaller. Re-exported (rather than imported by users of this module from
# platform) because app.security and the tests already patch app.db.LEM_HOME.
LEM_HOME: Path = platform_config.LEM_HOME

# Database path: $LEM_HOME/lem.db, ~/.lem/lem.db unless the install moved.
DB_PATH = LEM_HOME / "lem.db"

# The database holds secrets at rest (Ed25519 private key, signaling JWT), so the
# directory is owner-only and every database file is 0600.
DIR_MODE = 0o700
FILE_MODE = 0o600

# SQLite in WAL mode keeps two sidecar files next to the database.
DB_SIDECAR_SUFFIXES = ("-wal", "-shm")


class DatabaseError(Exception):
    """Base exception for database errors."""

    pass


def secure_lem_home(path: Path | None = None) -> Path:
    """
    Create the Lem home directory (if needed) and restrict it to the owner.

    Args:
        path: Directory to secure (defaults to ~/.lem)

    Returns:
        Path to the secured directory
    """
    target = LEM_HOME if path is None else path
    target.mkdir(parents=True, exist_ok=True, mode=DIR_MODE)
    _chmod(target, DIR_MODE)
    return target


def secure_db_files() -> None:
    """
    Restrict the database and its WAL/SHM sidecars to owner read/write.

    Called on every connection open because SQLite recreates the sidecar
    files with the process umask whenever a WAL transaction starts.
    """
    for path in (DB_PATH, *(Path(f"{DB_PATH}{sfx}") for sfx in DB_SIDECAR_SUFFIXES)):
        if path.exists():
            _chmod(path, FILE_MODE)


def _chmod(path: Path, mode: int) -> None:
    """
    Best-effort chmod.

    POSIX permissions are advisory on Windows/WSL mounts, so a failure here is
    logged rather than fatal - it must not stop the server from starting.

    Args:
        path: Path to restrict
        mode: Octal permission bits
    """
    try:
        path.chmod(mode)
    except OSError as e:
        logger.warning(f"Could not set permissions {mode:o} on {path}: {e}")


def init_db() -> None:
    """
    Initialize database with v0.1 schema.
    Creates tables if they don't exist and enables WAL mode.
    """
    # Ensure ~/.lem exists and is owner-only (it stores secrets)
    secure_lem_home()

    conn = sqlite3.connect(str(DB_PATH))
    secure_db_files()
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
                privkey TEXT,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS auth (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                state_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                service_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                progress INTEGER DEFAULT 0,
                message TEXT DEFAULT '',
                error TEXT,
                extra_json TEXT DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
            CREATE INDEX IF NOT EXISTS idx_jobs_service_id ON jobs(service_id);
            CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
        """
        )

        conn.commit()
    finally:
        secure_db_files()
        conn.close()


@contextmanager
def get_db() -> Generator[sqlite3.Connection, None, None]:
    """
    Context manager for database connections.
    Ensures connection is closed after use.
    """
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row  # Enable dict-like access
    # Fix up permissions left behind by an earlier crash...
    secure_db_files()
    try:
        yield conn
    finally:
        # ...and on the WAL/SHM files this connection just created.
        secure_db_files()
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

    def __init__(self, id: str, pubkey: str, created_at: datetime, privkey: str | None = None):
        self.id = id
        self.pubkey = pubkey
        self.privkey = privkey
        self.created_at = created_at

    def to_dict(self) -> dict[str, str | None]:
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
        cursor = conn.execute("SELECT id, pubkey, privkey, created_at FROM device LIMIT 1")
        row = cursor.fetchone()
        if not row:
            return None

        return Device(
            id=row["id"],
            pubkey=row["pubkey"],
            privkey=row["privkey"],
            created_at=datetime.fromisoformat(row["created_at"]),
        )


def register_device(device_id: str, pubkey: str, privkey: str | None = None) -> Device:
    """
    Register this device (insert or replace).

    Args:
        device_id: Unique device ID
        pubkey: Ed25519 public key (base64 encoded)
        privkey: Ed25519 private key (base64 encoded, optional)

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
            created_at = datetime.now(UTC)
            conn.execute(
                "INSERT INTO device (id, pubkey, privkey, created_at) VALUES (?, ?, ?, ?)",
                (device_id, pubkey, privkey, created_at.isoformat()),
            )
            conn.commit()

            return Device(id=device_id, pubkey=pubkey, privkey=privkey, created_at=created_at)
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
