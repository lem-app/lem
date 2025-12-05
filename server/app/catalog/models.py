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
Data models for the Harbor service catalog.
"""

from enum import Enum

from pydantic import BaseModel, Field


class ServiceCategory(str, Enum):
    """Category of a Harbor service."""

    BACKEND = "backend"  # LLM inference engines (Ollama, vLLM, LocalAI)
    FRONTEND = "frontend"  # Chat UIs (Open WebUI, LibreChat, ComfyUI)
    SATELLITE = "satellite"  # Tools & utilities (Aider, Langfuse, SearXNG)


class ServiceStatus(str, Enum):
    """Runtime status of a service."""

    NOT_INSTALLED = "not_installed"
    STOPPED = "stopped"
    RUNNING = "running"
    ERROR = "error"


class ScannedService(BaseModel):
    """
    Service data extracted from scanning a Harbor compose file.

    This contains only what we can reliably extract from the YAML:
    - id: derived from filename (compose.ollama.yml -> ollama)
    - container_port: primary port inside the container
    - image: Docker image reference
    """

    id: str = Field(description="Service ID derived from compose filename")
    container_port: int | None = Field(
        default=None, description="Primary container port (e.g., 11434 for Ollama)"
    )
    image: str = Field(default="", description="Docker image reference")


class ServiceMetadata(BaseModel):
    """
    Curated metadata for a Harbor service.

    This contains human-friendly information that can't be extracted
    from compose files: display names, descriptions, categories, tags.
    """

    name: str = Field(description="Human-friendly display name")
    category: ServiceCategory = Field(description="Service category")
    description: str = Field(description="Short description of the service")
    tags: list[str] = Field(default_factory=list, description="Searchable tags")
    depends_on: list[str] = Field(
        default_factory=list, description="Service IDs this service depends on"
    )
    has_api: bool = Field(
        default=False, description="Whether the service exposes an HTTP API"
    )
    has_ui: bool = Field(
        default=False, description="Whether the service has a web UI"
    )


class ServiceDefinition(BaseModel):
    """
    Complete service definition combining scanned data and metadata.

    This is the primary model used throughout the application.
    """

    id: str = Field(description="Service ID (Harbor service name)")
    name: str = Field(description="Human-friendly display name")
    category: ServiceCategory = Field(description="Service category")
    description: str = Field(description="Short description")
    container_port: int | None = Field(
        default=None, description="Primary container port"
    )
    image: str = Field(default="", description="Docker image reference")
    tags: list[str] = Field(default_factory=list, description="Searchable tags")
    depends_on: list[str] = Field(
        default_factory=list, description="Service IDs this depends on"
    )
    has_api: bool = Field(default=False, description="Exposes HTTP API")
    has_ui: bool = Field(default=False, description="Has web UI")


class Service(BaseModel):
    """
    Runtime service instance with current status.

    Combines the static definition with runtime information.
    """

    id: str
    name: str
    category: ServiceCategory
    description: str
    status: ServiceStatus
    host_port: int | None = Field(
        default=None, description="Mapped host port when running"
    )
    endpoint: str | None = Field(default=None, description="Full URL when running")
    tags: list[str] = Field(default_factory=list)
    depends_on: list[str] = Field(default_factory=list)
    has_api: bool = False
    has_ui: bool = False
    error_message: str | None = None
