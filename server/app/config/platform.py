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
Platform detection and configuration for Lem.

Centralizes all platform-specific behavior:
- OS detection (macOS, Linux, Windows)
- Docker socket path detection
- Standard paths (LEM_HOME, HARBOR_SCRIPT)

Usage:
    from app.config.platform import PLATFORM, DOCKER_HOST, LEM_HOME

    if PLATFORM == "macos":
        # macOS-specific code
        pass
"""

from __future__ import annotations

import os
import platform
from pathlib import Path
from typing import Literal

# Detect operating system
OS_TYPE: str = platform.system()  # "Darwin", "Linux", "Windows"
ARCH: str = platform.machine()  # "x86_64", "arm64", "aarch64"

PlatformType = Literal["macos", "linux", "windows"]


def get_platform() -> PlatformType:
    """
    Returns normalized platform name.

    Returns:
        "macos", "linux", or "windows"

    Raises:
        RuntimeError: If platform is not supported
    """
    if OS_TYPE == "Darwin":
        return "macos"
    elif OS_TYPE == "Linux":
        return "linux"
    elif OS_TYPE == "Windows":
        return "windows"
    else:
        raise RuntimeError(f"Unsupported platform: {OS_TYPE}")


PLATFORM: PlatformType = get_platform()

# Standard paths
LEM_HOME: Path = Path.home() / ".lem"
HARBOR_DIR: Path = LEM_HOME / "harbor"
HARBOR_SCRIPT: Path = HARBOR_DIR / "harbor.sh"
DATA_DIR: Path = LEM_HOME / "data"
LOGS_DIR: Path = LEM_HOME / "logs"


def get_docker_socket_path() -> Path:
    """
    Returns platform-specific Docker socket path.

    Checks DOCKER_HOST environment variable first, then uses platform defaults:
    - macOS: ~/.docker/run/docker.sock (Docker Desktop)
    - Linux: /var/run/docker.sock (native Docker)
    - Windows: /var/run/docker.sock (inside WSL2)

    Returns:
        Path to Docker socket
    """
    # Allow override via environment variable
    if override := os.getenv("DOCKER_HOST"):
        # Strip protocol prefix if present
        path_str = override.replace("unix://", "").replace("npipe://", "")
        return Path(path_str)

    if PLATFORM == "macos":
        # Docker Desktop for Mac
        return Path.home() / ".docker" / "run" / "docker.sock"

    elif PLATFORM == "linux":
        # Native Docker on Linux
        return Path("/var/run/docker.sock")

    elif PLATFORM == "windows":
        # Windows with WSL2: use WSL socket path
        # (Harbor runs inside WSL, so it sees Linux-style paths)
        wsl_socket = Path("/var/run/docker.sock")
        if wsl_socket.exists():
            return wsl_socket

        # Fallback to Windows named pipe (if running outside WSL)
        return Path("//./pipe/docker_engine")

    else:
        raise RuntimeError(f"Cannot determine Docker socket for platform: {PLATFORM}")


def get_docker_host_uri() -> str:
    """
    Returns DOCKER_HOST environment variable value.

    Returns:
        URI string like "unix:///path/to/socket" or "npipe://./pipe/docker_engine"
    """
    socket_path = get_docker_socket_path()

    # Windows named pipe uses npipe:// protocol
    if str(socket_path).startswith("//./pipe/"):
        return f"npipe://{socket_path}"

    # Unix sockets use unix:// protocol
    return f"unix://{socket_path}"


# Pre-computed values for common use
DOCKER_SOCKET: Path = get_docker_socket_path()
DOCKER_HOST: str = get_docker_host_uri()
