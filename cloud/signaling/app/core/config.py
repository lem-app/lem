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

"""Configuration settings for the signaling server."""

import json
from typing import Any, Self

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

    # JWT settings. There is deliberately no usable default: an unset or
    # example secret key means every reader of this public repository can mint
    # tokens for any user, so the process refuses to start instead.
    secret_key: str = ""
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24  # 24 hours

    # Lifetime of a relay session grant. Short: it only has to survive the
    # round trip from "connect-request" to the relay WebSocket handshake.
    relay_grant_ttl_seconds: int = 120

    # How long a device-registration or WebSocket challenge stays redeemable.
    challenge_ttl_seconds: int = 120

    # Database
    database_url: str = "sqlite+aiosqlite:///./signaling.db"

    # Server
    host: str = "0.0.0.0"
    port: int = 8000

    # CORS - comma-separated list of allowed origins. No default and no
    # wildcard: the API is credentialed, and "*" with credentials makes
    # Starlette reflect the caller's own Origin (see main.py).
    cors_origins: str = ""

    # Rate limiting (per client IP unless noted). Counters live in this
    # process, which is correct only with --workers 1; see deploy/.
    max_connections_per_second: int = 5  # /signal WebSocket handshakes
    max_registrations_per_hour: int = 5  # POST /auth/register
    max_logins_per_minute: int = 10  # POST /auth/login, per IP and per email

    # Set to true only when a trusted reverse proxy (the shipped nginx
    # configs) appends the real client address to X-Forwarded-For. Trusting
    # the header without such a proxy lets any caller spoof its own IP and
    # bypass every per-IP limit above.
    trust_x_forwarded_for: bool = False

    # Relay server
    relay_url: str = "ws://localhost:8001"

    # ICE servers configuration (JSON string)
    # Format: [{"urls": "stun:stun.l.google.com:19302"},
    #          {"urls": "turn:...", "username": "...", "credential": "..."}]
    # Default: Google's public STUN server
    ice_servers_json: str = '[{"urls": "stun:stun.l.google.com:19302"}]'

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

    @property
    def ice_servers(self) -> list[dict[str, Any]]:
        """Parse ICE servers from JSON string.

        Returns:
            List of ICE server configuration dictionaries.
        """
        try:
            parsed: list[dict[str, Any]] = json.loads(self.ice_servers_json)
        except json.JSONDecodeError:
            # Fall back to default STUN server on parse error
            return [{"urls": "stun:stun.l.google.com:19302"}]
        return parsed


settings = Settings()
