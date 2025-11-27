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

import os
from typing import Self

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Default key used for development - NEVER use in production
_DEFAULT_SECRET_KEY = "dev-secret-key-change-in-production"


class Settings(BaseSettings):
    """Application settings."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    # JWT settings (must match signaling server for interop)
    secret_key: str = _DEFAULT_SECRET_KEY

    @model_validator(mode="after")
    def validate_secret_key_for_production(self) -> Self:
        """Ensure default secret key is not used in production."""
        env = os.getenv("ENV", "").lower()
        if env == "production" and self.secret_key == _DEFAULT_SECRET_KEY:
            raise ValueError(
                "Cannot use default secret key in production. "
                "Set SECRET_KEY environment variable to a secure random value."
            )
        return self
    algorithm: str = "HS256"

    # Server
    host: str = "0.0.0.0"
    port: int = 8001  # Different from signaling (8000)

    # CORS - comma-separated list of allowed origins
    cors_origins: str = "*"  # Use "*" for dev, specific origins for production

    # Session timeout (seconds)
    session_timeout: int = 300  # 5 minutes idle timeout

    # WebSocket settings
    ws_ping_interval: int = 20  # Ping every 20 seconds
    ws_ping_timeout: int = 10  # Close if no pong in 10 seconds


settings = Settings()
