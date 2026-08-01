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

"""Machine-readable reasons carried on relay error frames.

Every ``{"type": "error"}`` frame the relay sends carries a ``reason`` from
this list and an explicit ``retryable`` boolean, so a client can tell a
transient capacity rejection from a permanent authentication failure *on the
frame itself*.

Previously the two were distinguishable only by the WebSocket close code
(1013 versus 1008), which arrives separately from the error frame and may not
arrive at all if the socket drops first. Clients therefore read the error frame
and stopped reconnecting on any of them, turning "the relay is busy, come back
in a moment" into "sign in again" and killing reconnection for the session.
"""

from typing import Final


class ErrorReason:
    """Reason codes sent on relay error frames.

    Terminal reasons mean the client must change something (credentials, the
    session it is asking for) before another attempt can work. Retryable
    reasons mean the same request may succeed later, unchanged.
    """

    # --- Terminal: retrying with the same inputs cannot succeed -------------

    # The grant was missing, malformed, expired, wrongly scoped, or minted for
    # a different session. Re-authenticate and obtain a fresh grant.
    AUTH_FAILED: Final = "auth-failed"

    # The grant was valid but has already been redeemed. Grants are single use
    # for their whole lifetime; a new connect-request is required.
    GRANT_ALREADY_USED: Final = "grant-already-used"

    # The grant does not describe this session's user or device pair.
    SESSION_MISMATCH: Final = "session-mismatch"

    # Both slots of this session are occupied.
    SESSION_FULL: Final = "session-full"

    # This device already holds a connection to this session.
    DEVICE_ALREADY_CONNECTED: Final = "device-already-connected"

    # The session was torn down while this connection was being admitted.
    SESSION_CLOSED: Final = "session-closed"

    # The client broke the handshake protocol: wrong first message, bad JSON,
    # or an oversized frame.
    PROTOCOL_ERROR: Final = "protocol-error"

    # The client used a protocol version this server no longer speaks. The
    # only cure is upgrading the client.
    UNSUPPORTED_CLIENT: Final = "unsupported-client"

    # --- Retryable: the same request may succeed later ---------------------

    # The relay has no room for another session right now.
    RELAY_AT_CAPACITY: Final = "relay-at-capacity"

    # This account already holds as many concurrent sessions as it may.
    ACCOUNT_SESSION_LIMIT: Final = "account-session-limit"


# Reasons for which a client should back off and try again rather than
# surfacing a permanent failure and disabling reconnection.
RETRYABLE_REASONS: Final[frozenset[str]] = frozenset(
    {ErrorReason.RELAY_AT_CAPACITY, ErrorReason.ACCOUNT_SESSION_LIMIT}
)
