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
Harbor CLI probes for Lem.

Harbor is a git checkout at ~/.lem/harbor with a harbor.sh entrypoint (see
app.config.platform.HARBOR_SCRIPT), and Docker routing happens through the
DOCKER_HOST environment variable.

Service lifecycle (up/down) lives in app.services.lifecycle, which runs Harbor
off the event loop; the blocking harbor_up/harbor_down/harbor_ps helpers that
used to live here were a second, event-loop-freezing copy of that code and
have been removed. What remains are the read-only probes used by /v1/health.
"""

from __future__ import annotations

import logging
import subprocess

from app.config.platform import HARBOR_SCRIPT

logger = logging.getLogger(__name__)

PROBE_TIMEOUT = 10


class HarborError(Exception):
    """Raised when a Harbor CLI operation fails"""

    def __init__(self, message: str, stderr: str = "", exit_code: int = 1):
        super().__init__(message)
        self.stderr = stderr
        self.exit_code = exit_code


def check_harbor_installed() -> str:
    """
    Verify Harbor CLI is installed and get its version.

    Returns:
        str: Harbor version (e.g., "0.3.20")

    Raises:
        HarborError: If Harbor CLI is missing, hung, or fails
    """
    try:
        result = subprocess.run(
            [str(HARBOR_SCRIPT), "--version"],
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT,
            check=True,
        )
    except OSError as e:
        raise HarborError(
            f"Harbor CLI not usable at {HARBOR_SCRIPT}: {e}. "
            "Install Harbor (or re-run the Lem installer) and try again."
        ) from e
    except subprocess.TimeoutExpired as e:
        raise HarborError(
            f"Harbor version check timed out after {PROBE_TIMEOUT} seconds",
            exit_code=124,
        ) from e
    except subprocess.CalledProcessError as e:
        raise HarborError(
            f"Harbor version check failed: {e.stderr}", e.stderr or "", e.returncode
        ) from e

    # Output format varies between Harbor releases; take the last token.
    tokens = result.stdout.strip().split()
    if not tokens:
        raise HarborError(f"Harbor at {HARBOR_SCRIPT} reported an empty version")

    version = tokens[-1]
    logger.info(f"Harbor CLI version: {version}")
    return version


def check_harbor_requirements() -> tuple[bool, list[str]]:
    """
    Run harbor doctor to validate system requirements.

    Checks:
    - Docker installed and running
    - Docker Compose v2 installed (>2.23.1)
    - Harbor home directory accessible
    - Profile files readable

    Returns:
        tuple[bool, list[str]]: (all_checks_passed, list_of_error_messages)

    Example:
        >>> ok, issues = check_harbor_requirements()
        >>> if not ok:
        ...     for issue in issues:
        ...         print(f"ERROR: {issue}")
    """
    try:
        result = subprocess.run(
            [str(HARBOR_SCRIPT), "doctor"],
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT,
            check=False,  # Don't raise on non-zero exit
        )
    except subprocess.TimeoutExpired:
        logger.error("Harbor doctor timed out")
        return False, [f"Harbor doctor timed out after {PROBE_TIMEOUT} seconds"]
    except OSError as e:
        return False, [f"Harbor CLI not usable at {HARBOR_SCRIPT}: {e}"]

    # Parse output for ERROR lines
    errors = []
    for line in result.stdout.split("\n"):
        if "[ERROR]" in line:
            # Extract error message after the ✘ symbol
            msg = line.split("✘")[-1].strip()
            errors.append(msg)

    logger.info(f"Harbor doctor completed with {len(errors)} errors")
    return len(errors) == 0, errors
