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

"""Configuration settings for the relay server."""

from typing import Self

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Secret keys that were shipped in this repository's examples. HS256 is
# symmetric and the repository is public, so anyone can forge tokens with
# these. They are rejected outright rather than merely discouraged.
_BANNED_SECRET_KEYS = frozenset(
    {
        "dev-secret-key-change-in-production",
        "change-me",
        "secret",
    }
)

# Shortest key we accept. 32 characters is the output of `openssl rand -hex 16`.
_MIN_SECRET_KEY_LENGTH = 32


class Settings(BaseSettings):
    """Application settings."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    # JWT settings (must match the signaling server: it mints the session
    # grants this server verifies). There is deliberately no usable default.
    secret_key: str = ""
    algorithm: str = "HS256"

    # Server
    host: str = "0.0.0.0"
    port: int = 8001  # Different from signaling (8000)

    # CORS - comma-separated list of allowed origins. No default and no
    # wildcard: see main.py.
    cors_origins: str = ""

    # Idle timeout while forwarding: close a paired session that has carried
    # no frames in this long, so half-dead tunnels do not accumulate.
    session_timeout: int = 300  # 5 minutes

    # How long the first peer waits alone before the session is abandoned.
    # Without this the first connection parked forever and leaked a session
    # and a coroutine per attempt.
    pair_timeout: int = 30

    # Bytes the first peer may send before its partner arrives. Frames sent
    # during this window are buffered and flushed on pairing.
    max_prepair_buffer_bytes: int = 256 * 1024

    # Capacity limits. Sessions are in-process, so these bound this worker.
    max_sessions: int = 1000
    max_sessions_per_user: int = 10

    # WebSocket settings
    ws_ping_interval: int = 20  # Ping every 20 seconds
    ws_ping_timeout: int = 10  # Close if no pong in 10 seconds

    @model_validator(mode="after")
    def validate_fail_closed_settings(self) -> Self:
        """Reject configurations that would silently disable authentication.

        Returns:
            The validated settings.

        Raises:
            ValueError: If the secret key or CORS origins are unsafe.
        """
        if not self.secret_key:
            raise ValueError(
                "SECRET_KEY is required and has no default. Generate one with "
                "`openssl rand -hex 32` and set it identically on the signaling "
                "and relay servers."
            )
        if self.secret_key in _BANNED_SECRET_KEYS:
            raise ValueError(
                "SECRET_KEY is one of the example values published in this "
                "repository. Generate a private one with `openssl rand -hex 32`."
            )
        if len(self.secret_key) < _MIN_SECRET_KEY_LENGTH:
            raise ValueError(
                f"SECRET_KEY must be at least {_MIN_SECRET_KEY_LENGTH} characters; "
                "generate one with `openssl rand -hex 32`."
            )
        if not self.cors_allowed_origins:
            raise ValueError(
                "CORS_ORIGINS is required and has no default. Set an explicit "
                "comma-separated origin list, e.g. "
                "CORS_ORIGINS=https://app.lem.gg,http://localhost:5173"
            )
        if "*" in self.cors_allowed_origins:
            raise ValueError(
                "CORS_ORIGINS must not contain '*'. This API is credentialed, and "
                "a wildcard with credentials makes the server reflect whatever "
                "Origin the caller sends."
            )
        return self

    @property
    def cors_allowed_origins(self) -> list[str]:
        """Parse the configured CORS origins into a list.

        Returns:
            Explicit list of allowed origins, empty if unset.
        """
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


settings = Settings()
