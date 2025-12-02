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
Services module for managing Harbor service lifecycle.

Provides:
- Service status checking (not_installed, stopped, running)
- Service lifecycle operations (install, start, stop, remove)
- Dependency resolution and auto-installation
- Integration with job queue for async operations
"""

from app.services.lifecycle import (
    install_service,
    remove_service,
    start_service,
    stop_service,
)
from app.services.status import (
    get_all_services_with_status,
    get_service_endpoint,
    get_service_status,
)

__all__ = [
    # Lifecycle operations
    "install_service",
    "start_service",
    "stop_service",
    "remove_service",
    # Status operations
    "get_service_status",
    "get_service_endpoint",
    "get_all_services_with_status",
]
