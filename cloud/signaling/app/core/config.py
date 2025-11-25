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
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    # JWT settings
    secret_key: str = "dev-secret-key-change-in-production"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24  # 24 hours

    # Database
    database_url: str = "sqlite+aiosqlite:///./signaling.db"

    # Server
    host: str = "0.0.0.0"
    port: int = 8000

    # CORS - comma-separated list of allowed origins
    cors_origins: str = "*"  # Use "*" for dev, specific origins for production

    # Rate limiting
    max_connections_per_second: int = 5

    # Relay server
    relay_url: str = "ws://localhost:8001"

    # ICE servers configuration (JSON string)
    # Format: [{"urls": "stun:stun.l.google.com:19302"}, {"urls": "turn:...", "username": "...", "credential": "..."}]
    # Default: Google's public STUN server
    ice_servers_json: str = '[{"urls": "stun:stun.l.google.com:19302"}]'

    @property
    def ice_servers(self) -> list[dict[str, Any]]:
        """Parse ICE servers from JSON string."""
        try:
            return json.loads(self.ice_servers_json)
        except json.JSONDecodeError:
            # Fall back to default STUN server on parse error
            return [{"urls": "stun:stun.l.google.com:19302"}]


settings = Settings()
