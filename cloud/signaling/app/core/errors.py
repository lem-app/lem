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

"""Machine-readable reasons carried on signaling error frames.

Every ``{"type": "error"}`` frame the signaling server sends carries a
``reason`` from this list and an explicit ``retryable`` boolean. Clients branch
on those rather than on the human-readable ``message`` (which may be reworded)
or on a WebSocket close code (which arrives separately from the frame, and may
not arrive at all if the socket drops first).
"""

from typing import Final


class ErrorReason:
    """Reason codes sent on signaling error frames."""

    # --- Terminal: retrying with the same inputs cannot succeed -------------

    # The account token was missing, malformed, expired, wrongly scoped, or the
    # device is not this account's.
    AUTH_FAILED: Final = "auth-failed"

    # The ed25519 signature over the connection challenge did not verify. The
    # client is holding the wrong private key for this device.
    DEVICE_KEY_VERIFICATION_FAILED: Final = "device-key-verification-failed"

    # The client broke the handshake or message protocol.
    PROTOCOL_ERROR: Final = "protocol-error"

    # The client used a protocol version this server no longer speaks. The only
    # cure is upgrading the client.
    UNSUPPORTED_CLIENT: Final = "unsupported-client"

    # A relay session needs two distinct devices.
    SAME_DEVICE: Final = "same-device"

    # --- Retryable: the same request may succeed later ---------------------

    # Uniform answer for a target that does not exist, is not yours, or is not
    # connected. Deliberately indistinguishable, and deliberately retryable:
    # the common case is a device that is simply offline right now.
    TARGET_UNAVAILABLE: Final = "target-unavailable"

    # Something failed server-side while handling the message.
    INTERNAL_ERROR: Final = "internal-error"


# Reasons for which a client should back off and try again rather than
# surfacing a permanent failure and disabling reconnection.
RETRYABLE_REASONS: Final[frozenset[str]] = frozenset(
    {ErrorReason.TARGET_UNAVAILABLE, ErrorReason.INTERNAL_ERROR}
)
