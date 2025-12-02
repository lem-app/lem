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
Catalog module for discovering and managing Harbor services.

This module provides:
- Dynamic discovery of Harbor services by scanning compose files
- Curated metadata (names, descriptions, categories) for known services
- Service definition merging (scanned data + metadata)
"""

from app.catalog.models import (
    ScannedService,
    ServiceCategory,
    ServiceDefinition,
    ServiceMetadata,
)
from app.catalog.registry import (
    get_all_services,
    get_service_definition,
    get_service_dependencies,
)
from app.catalog.scanner import scan_dependencies, scan_harbor_services

__all__ = [
    # Models
    "ServiceCategory",
    "ServiceDefinition",
    "ServiceMetadata",
    "ScannedService",
    # Registry functions
    "get_all_services",
    "get_service_definition",
    "get_service_dependencies",
    # Scanner functions
    "scan_harbor_services",
    "scan_dependencies",
]
