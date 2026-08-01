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

"""Tunnel protocol v3 error taxonomy.

One numeric space serves both the ``HTTP_CANCEL.reason_code`` field on the wire
and the error codes the browser surfaces to a caller. Codes are allocated as
``1000 + ordinal`` so they fit the uint16 ``reason_code`` field.

The same table exists in ``web/remote/src/lib/tunnel-errors.ts``, and both are
pinned to ``protocol/tunnel-v3.json`` by tests in both languages. That fixture
is the single source of truth: FrameType drifted between the Python and
TypeScript codecs once already (v1 to v2), and a table nobody cross-checks is
how it happened.
"""

from enum import IntEnum


class TunnelErrorCode(IntEnum):
    """Machine-readable tunnel failure reasons (spec section 7.1)."""

    E_NO_SESSION = 1000
    E_DEVICE_MISMATCH = 1001
    E_SW_FORBIDDEN = 1002
    E_BRIDGE_UNAVAILABLE = 1003
    E_TUNNEL_DOWN = 1004
    E_SESSION_CLOSED = 1005
    E_TIMEOUT_HEAD = 1006
    E_TIMEOUT_STREAM = 1007
    E_TOO_LARGE = 1008
    E_PROTO_VERSION = 1009
    E_PROTO_V2_FRAME = 1010
    E_PROTO_MALFORMED = 1011
    E_UPSTREAM = 1012
    E_UNKNOWN_SERVICE = 1013
    E_INTERNAL = 1014


# HTTP status each code renders as when it has to become a response.
HTTP_STATUS_FOR_ERROR: dict[TunnelErrorCode, int] = {
    TunnelErrorCode.E_NO_SESSION: 421,
    TunnelErrorCode.E_DEVICE_MISMATCH: 409,
    TunnelErrorCode.E_SW_FORBIDDEN: 403,
    TunnelErrorCode.E_BRIDGE_UNAVAILABLE: 503,
    TunnelErrorCode.E_TUNNEL_DOWN: 503,
    TunnelErrorCode.E_SESSION_CLOSED: 410,
    TunnelErrorCode.E_TIMEOUT_HEAD: 504,
    TunnelErrorCode.E_TIMEOUT_STREAM: 504,
    TunnelErrorCode.E_TOO_LARGE: 502,
    TunnelErrorCode.E_PROTO_VERSION: 502,
    TunnelErrorCode.E_PROTO_V2_FRAME: 502,
    TunnelErrorCode.E_PROTO_MALFORMED: 502,
    TunnelErrorCode.E_UPSTREAM: 502,
    TunnelErrorCode.E_UNKNOWN_SERVICE: 502,
    TunnelErrorCode.E_INTERNAL: 500,
}


class TunnelProtocolError(ValueError):
    """A frame violated the protocol.

    Subclasses ``ValueError`` so callers that only care that the frame was bad
    keep working, while callers that have to answer the peer can read
    :attr:`code` and put the right ``reason_code`` on the wire.
    """

    def __init__(self, code: TunnelErrorCode, message: str) -> None:
        """Initialize the error.

        Args:
            code: Taxonomy code for the failure
            message: Local-only detail; never sent to the peer verbatim
        """
        super().__init__(message)
        self.code = code

    @property
    def http_status(self) -> int:
        """HTTP status this failure renders as.

        Returns:
            Status code from :data:`HTTP_STATUS_FOR_ERROR`
        """
        return HTTP_STATUS_FOR_ERROR[self.code]
