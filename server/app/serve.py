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
Lem's server entrypoint - the single source of truth for the bind address.

Run it as ``uv run lem-serve`` or ``python -m app.serve``.

Why this module exists: the security posture of the local API (whether a bearer
token is required on ``/v1/*``) must follow the address the process is really
listening on. Invoking ``uvicorn app.main:app --host ...`` splits that decision
in two - ``$LEM_HOST`` fed the auth gate while ``--host`` fed the kernel - and a
mismatch published a Docker control plane to the network while the log claimed
loopback.

Here the socket is bound *first*, its address is read back with
``getsockname()``, and the posture is installed from that observation before a
single request can be accepted. ``$LEM_HOST``/``$LEM_PORT`` are the only inputs,
and they are a request; the socket is the answer.
"""

import logging
import socket
import sys

import uvicorn

from app.security import (
    REQUIRE_TOKEN_ENV_VAR,
    TOKEN_PATH,
    get_bind_host,
    get_bind_port,
    token_required,
    verify_bind_posture,
)

logger = logging.getLogger("app.serve")

APP_TARGET = "app.main:app"


def build_config(host: str, port: int) -> uvicorn.Config:
    """
    Build the uvicorn configuration for the local server.

    Args:
        host: Address to bind
        port: Port to bind

    Returns:
        Uvicorn configuration
    """
    return uvicorn.Config(APP_TARGET, host=host, port=port, log_level="info")


def bind_and_verify(config: uvicorn.Config) -> socket.socket:
    """
    Bind the listening socket and install the posture read back from it.

    Args:
        config: Uvicorn configuration carrying the requested host/port

    Returns:
        The bound socket, ready to be handed to the server
    """
    sock = config.bind_socket()
    posture = verify_bind_posture([sock])

    if posture.verified and posture.loopback_only and token_required():
        # $LEM_REQUIRE_TOKEN is on. The socket really is loopback-only, but the
        # operator has told us something sits in front of it.
        logger.info(
            f"✓ Lem local API {posture.describe()}; ${REQUIRE_TOKEN_ENV_VAR} is set, so every "
            f"/v1/* request requires 'Authorization: Bearer <token>' using the token in "
            f"{TOKEN_PATH}."
        )
    elif posture.verified and posture.loopback_only:
        logger.info(f"✓ Lem local API {posture.describe()}; bearer token accepted but not required")
    elif posture.verified:
        logger.warning(
            f"⚠ Lem local API {posture.describe()}. Every /v1/* request requires "
            f"'Authorization: Bearer <token>' using the token in {TOKEN_PATH}."
        )
    else:
        logger.error(
            f"⚠ Lem local API {posture.describe()}. Failing closed: every /v1/* request "
            f"requires 'Authorization: Bearer <token>' using the token in {TOKEN_PATH}."
        )

    return sock


def main() -> int:
    """
    Start the local server on a verified socket.

    Returns:
        Process exit code
    """
    host = get_bind_host()
    port = get_bind_port()

    config = build_config(host, port)
    sock = bind_and_verify(config)

    server = uvicorn.Server(config)
    server.run(sockets=[sock])
    return 0


if __name__ == "__main__":
    sys.exit(main())
