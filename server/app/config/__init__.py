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
Configuration module for Lem server.

Provides platform detection and environment configuration.
"""

from app.config.platform import (
    ARCH,
    DOCKER_HOST,
    DOCKER_SOCKET,
    LEM_HOME,
    OS_TYPE,
    PLATFORM,
    PlatformType,
    get_docker_host_uri,
    get_docker_socket_path,
    get_platform,
)

__all__ = [
    "PLATFORM",
    "OS_TYPE",
    "ARCH",
    "LEM_HOME",
    "DOCKER_SOCKET",
    "DOCKER_HOST",
    "PlatformType",
    "get_platform",
    "get_docker_socket_path",
    "get_docker_host_uri",
]
