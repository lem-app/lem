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
- OS detection (macOS, Linux, Linux-under-WSL2)
- Docker endpoint detection (DOCKER_HOST / socket path)
- Standard paths (LEM_HOME, HARBOR_SCRIPT)

Windows is supported through WSL2 only, where ``platform.system()`` reports
"Linux". Native Windows (Python running outside WSL) is rejected explicitly
rather than half-supported.

Usage:
    from app.config.platform import DOCKER_HOST, LEM_HOME, PLATFORM

    if PLATFORM == "macos":
        ...
"""

from __future__ import annotations

import os
import platform
from pathlib import Path
from typing import Literal

PlatformType = Literal["macos", "linux"]

# Raw values, kept for reporting (e.g. /v1/health)
OS_TYPE: str = platform.system()  # "Darwin", "Linux", "Windows"
ARCH: str = platform.machine()  # "x86_64", "arm64", "aarch64"

# Schemes that address a local socket file rather than a network endpoint.
_LOCAL_SOCKET_SCHEMES = frozenset({"unix", "npipe"})


def get_platform() -> PlatformType:
    """
    Return the normalized platform name.

    Returns:
        "macos" or "linux" (WSL2 reports "linux")

    Raises:
        RuntimeError: If the platform is not supported
    """
    os_type = platform.system()

    if os_type == "Darwin":
        return "macos"
    if os_type == "Linux":
        return "linux"
    if os_type == "Windows":
        raise RuntimeError(
            "Native Windows is not supported. Run Lem inside WSL2, where Docker "
            "and Harbor see Linux-style paths."
        )
    raise RuntimeError(f"Unsupported platform: {os_type}")


def is_wsl() -> bool:
    """
    Return True when running inside the Windows Subsystem for Linux.

    WSL kernels advertise themselves in /proc/version (e.g.
    "Linux version 5.15.0-microsoft-standard-WSL2 ..."). This is informational
    only: WSL behaves like Linux for Docker and Harbor purposes.
    """
    if platform.system() != "Linux":
        return False

    try:
        proc_version = Path("/proc/version").read_text(encoding="utf-8")
    except OSError:
        return False

    return "microsoft" in proc_version.lower()


PLATFORM: PlatformType = get_platform()
IS_WSL: bool = is_wsl()

# The install prefix. The installer accepts a custom one and bakes it into the
# launcher it generates, which exports it before starting the server.
LEM_HOME_ENV_VAR = "LEM_HOME"


def get_lem_home() -> Path:
    """
    Return the Lem install prefix.

    Honours $LEM_HOME, which ``~/.lem/bin/lem-server`` exports, so that a
    relocated install reads its database, API token and Harbor from the prefix
    it was actually installed to. Without this the server would silently fall
    back to ~/.lem, leaving real state (including the API token) outside the
    reach of ``install.sh --uninstall``.

    A blank or whitespace-only value counts as unset.

    Returns:
        Path to the install prefix (default: ~/.lem)
    """
    override = os.getenv(LEM_HOME_ENV_VAR, "").strip()
    if override:
        return Path(override).expanduser()

    return Path.home() / ".lem"


# Standard paths
LEM_HOME: Path = get_lem_home()
HARBOR_DIR: Path = LEM_HOME / "harbor"
HARBOR_SCRIPT: Path = HARBOR_DIR / "harbor.sh"


def get_docker_socket_path() -> Path | None:
    """
    Return the local Docker socket path, if there is one.

    Honours a DOCKER_HOST override when it names a local socket
    (``unix://`` or ``npipe://``). Remote endpoints (``tcp://``, ``ssh://``,
    ...) have no socket file, so None is returned.

    Platform defaults:
    - macOS: ~/.docker/run/docker.sock (Docker Desktop)
    - Linux (incl. WSL2): /var/run/docker.sock

    Returns:
        Path to the Docker socket, or None for a remote Docker endpoint
    """
    override = os.getenv("DOCKER_HOST")
    if override:
        scheme, separator, remainder = override.partition("://")
        if not separator:
            # No scheme at all - treat it as a bare socket path.
            return Path(override)
        if scheme.lower() in _LOCAL_SOCKET_SCHEMES:
            return Path(remainder)
        return None

    if PLATFORM == "macos":
        return Path.home() / ".docker" / "run" / "docker.sock"

    return Path("/var/run/docker.sock")


def get_docker_host_uri() -> str:
    """
    Return the value to export as DOCKER_HOST for Docker/Harbor subprocesses.

    A DOCKER_HOST already present in the environment is passed through
    untouched so remote daemons keep working; previously
    ``tcp://10.0.0.5:2375`` was rewritten to ``unix://tcp:/10.0.0.5:2375``.

    Returns:
        URI string, e.g. "unix:///var/run/docker.sock" or "tcp://10.0.0.5:2375"
    """
    override = os.getenv("DOCKER_HOST")
    if override:
        return override

    return f"unix://{get_docker_socket_path()}"


# Pre-computed values for common use
DOCKER_SOCKET: Path | None = get_docker_socket_path()
DOCKER_HOST: str = get_docker_host_uri()
