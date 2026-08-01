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
Session-credential exchange for browser clients of the local API.

``POST /v1/auth/session`` trades the root token in ``~/.lem/api_token`` for a
short-lived, memory-only session token; ``DELETE /v1/auth/session`` revokes the
one presented. See :mod:`app.sessions` for why the browser gets a derived
credential instead of the permanent one.

Unrelated to ``app.api.v1.auth``, which proxies *cloud* sign-in to the signaling
server. Same URL prefix, different principal: this file authenticates the
machine's operator to their own local API.
"""

import logging

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel

from app.security import extract_bearer, get_api_token, tokens_match
from app.sessions import SESSION_TTL, mint_session, revoke_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


class SessionResponse(BaseModel):
    """A minted session credential.

    Attributes:
        token: Bearer value to send on subsequent /v1/* requests
        expires_at: ISO 8601 UTC instant after which the token stops working
    """

    token: str
    expires_at: str


@router.post("/session", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
async def create_session(request: Request) -> SessionResponse:
    """
    Trade the root API token for a short-lived session token.

    Only ``~/.lem/api_token`` is accepted here, deliberately. The security
    middleware would happily let a live session token through - it is a valid
    credential for ``/v1/*`` - so if this endpoint went by the middleware's
    verdict alone, a stolen session could mint an unbroken chain of successors
    and the fixed TTL would protect nothing. The check below is what makes the
    expiry real.

    The requirement also holds on a verified loopback bind, where the middleware
    asks for no credential at all. That costs nothing (the operator already has
    the file) and closes the proxy-in-front-of-loopback shape that
    ``$LEM_REQUIRE_TOKEN`` exists for.

    Args:
        request: Incoming request, read for its Authorization header

    Returns:
        The minted session token and its expiry

    Raises:
        HTTPException: 401 if the root token is missing or wrong, 503 if the
            server has no token to compare against
    """
    expected = get_api_token()
    if expected is None:
        logger.error("Session exchange requested but no API token is available")
        raise HTTPException(
            status_code=503,
            detail={
                "type": "https://lem.gg/errors/token-unavailable",
                "title": "Service Unavailable",
                "detail": "The server could not load its API token.",
            },
        )

    presented = extract_bearer(request.headers.get("authorization"))
    if presented is None or not tokens_match(presented, expected):
        # No token material in the log line, valid or otherwise.
        logger.warning("Rejected session exchange: root API token missing or incorrect")
        raise HTTPException(
            status_code=401,
            detail={
                "type": "https://lem.gg/errors/unauthorized",
                "title": "Unauthorized",
                "detail": (
                    "The root API token is required to start a session. "
                    "It is the contents of ~/.lem/api_token."
                ),
            },
        )

    session = mint_session()
    logger.info(f"Minted a local API session valid for {SESSION_TTL}")
    return SessionResponse(token=session.token, expires_at=session.expires_at.isoformat())


@router.delete("/session", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(request: Request) -> Response:
    """
    Revoke the session token presented on this request.

    Idempotent and deliberately uninformative: an unknown token returns 204 like
    a known one, so this is not an oracle for guessing live sessions.

    Args:
        request: Incoming request, read for its Authorization header

    Returns:
        An empty 204 response
    """
    presented = extract_bearer(request.headers.get("authorization"))
    if presented is not None:
        revoke_session(presented)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
