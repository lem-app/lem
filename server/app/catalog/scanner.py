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
Harbor compose file scanner.

Scans ~/.lem/harbor/ directory for compose files to discover available services.
"""

from __future__ import annotations

import logging
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from app.catalog.models import ScannedService

logger = logging.getLogger(__name__)

# Harbor installation directory
HARBOR_DIR = Path.home() / ".lem" / "harbor"


def _extract_container_port(ports: list[str] | None) -> int | None:
    """
    Extract the primary container port from a ports list.

    Args:
        ports: List of port mappings like ["${HOST_PORT}:11434", "8080:8080"]

    Returns:
        The first container port found, or None
    """
    if not ports:
        return None

    for port_mapping in ports:
        # Handle formats:
        # - "${HARBOR_OLLAMA_HOST_PORT}:11434"
        # - "8080:8080"
        # - "33821:11434/tcp"
        port_str = str(port_mapping)

        # Split on ":" and take the last part (container port)
        parts = port_str.split(":")
        if len(parts) >= 2:
            container_part = parts[-1]
            # Remove protocol suffix if present (/tcp, /udp)
            container_part = container_part.split("/")[0]
            # Try to parse as int
            try:
                return int(container_part)
            except ValueError:
                continue

    return None


def _extract_image(image_str: str | None) -> str:
    """
    Extract a clean image reference from a compose image field.

    Args:
        image_str: Image string, possibly with env vars like "${HARBOR_OLLAMA_VERSION}"

    Returns:
        Cleaned image string
    """
    if not image_str:
        return ""
    return str(image_str)


@lru_cache(maxsize=1)
def scan_harbor_services() -> dict[str, ScannedService]:
    """
    Scan Harbor compose files to discover available services.

    Scans all compose.{service}.yml files in ~/.lem/harbor/ and extracts:
    - Service ID (from filename)
    - Container port
    - Docker image

    Skips:
    - Extension files (compose.x.*.yml)
    - Base compose.yml file
    - Non-service compose files

    Returns:
        Dict mapping service_id to ScannedService
    """
    if not HARBOR_DIR.exists():
        logger.warning(f"Harbor directory not found: {HARBOR_DIR}")
        return {}

    services: dict[str, ScannedService] = {}

    # Pattern: compose.{service}.yml but NOT compose.x.{service}.{dep}.yml
    for compose_file in HARBOR_DIR.glob("compose.*.yml"):
        filename = compose_file.name

        # Skip extension files
        if ".x." in filename:
            continue

        # Skip base compose.yml
        if filename == "compose.yml":
            continue

        # Extract service ID: compose.ollama.yml -> ollama
        match = re.match(r"compose\.([a-z0-9_-]+)\.yml", filename, re.IGNORECASE)
        if not match:
            continue

        service_id = match.group(1).lower()

        try:
            with open(compose_file, encoding="utf-8") as f:
                config = yaml.safe_load(f)

            if not config or "services" not in config:
                continue

            # Find the main service definition
            # Usually matches the service_id, but might have variations
            svc_config: dict[str, Any] | None = None
            for svc_name, svc_def in config["services"].items():
                # Match exact name or without suffixes like -init
                if svc_name == service_id or svc_name.startswith(f"{service_id}-"):
                    if svc_config is None or svc_name == service_id:
                        svc_config = svc_def

            if svc_config is None:
                # Take the first service if no match
                svc_config = next(iter(config["services"].values()), {})

            services[service_id] = ScannedService(
                id=service_id,
                container_port=_extract_container_port(svc_config.get("ports")),
                image=_extract_image(svc_config.get("image")),
            )

        except yaml.YAMLError as e:
            logger.warning(f"Failed to parse {compose_file}: {e}")
        except Exception as e:
            logger.warning(f"Error scanning {compose_file}: {e}")

    logger.info(f"Scanned {len(services)} Harbor services")
    return services


def scan_dependencies() -> dict[str, list[str]]:
    """
    Scan Harbor extension files to discover service dependencies.

    Extension files follow the pattern: compose.x.{service}.{dependency}.yml
    For example: compose.x.webui.ollama.yml means webui integrates with ollama

    Returns:
        Dict mapping service_id to list of dependency service_ids
    """
    if not HARBOR_DIR.exists():
        return {}

    deps: dict[str, set[str]] = {}

    for ext_file in HARBOR_DIR.glob("compose.x.*.yml"):
        filename = ext_file.name

        # Parse: compose.x.webui.ollama.yml -> webui depends on ollama
        # Also handles: compose.x.webui.searxng.ollama.yml (multiple deps)
        match = re.match(r"compose\.x\.([a-z0-9_-]+)\.([a-z0-9_-]+)\.yml", filename, re.IGNORECASE)
        if match:
            service = match.group(1).lower()
            dependency = match.group(2).lower()

            # Skip nvidia/cdi/rocm extensions (GPU configs, not dependencies)
            if dependency in ("nvidia", "cdi", "rocm"):
                continue

            if service not in deps:
                deps[service] = set()
            deps[service].add(dependency)

    # Convert sets to sorted lists for consistency
    return {k: sorted(v) for k, v in deps.items()}


def clear_cache() -> None:
    """Clear the scanner cache. Useful after Harbor updates."""
    scan_harbor_services.cache_clear()
