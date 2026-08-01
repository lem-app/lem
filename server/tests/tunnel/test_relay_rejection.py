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

"""Tests for relay rejection classification.

The relay puts ``reason`` and ``retryable`` on every ``{"type": "error"}``
frame (``cloud/relay/app/core/errors.py``) precisely so a client does not have
to infer permanence from a close code that arrives separately. Both directions
need pinning:

* a **retryable** rejection (relay busy, per-account session limit) must leave
  reconnection armed - otherwise a transient capacity condition permanently
  disables the relay fallback for the session;
* a **terminal** rejection (bad credentials, spent grant) must still stop it -
  otherwise the client loops forever against a rejection that cannot change.
"""

import json

import pytest

from app.tunnel.relay_client import (
    AUTH_RELAY_REASONS,
    RETRYABLE_RELAY_REASONS,
    RelayClient,
    RelayRejection,
)


def _client() -> RelayClient:
    """Build a relay client with no live socket.

    Returns:
        Client under test
    """
    return RelayClient(local_server_url="http://localhost:5142")


def _error_frame(reason: str, retryable: bool, message: str = "denied") -> str:
    """Build a relay error frame exactly as cloud/relay sends it.

    Args:
        reason: Machine-readable reason code
        retryable: Whether the relay marked it retryable
        message: Human-readable message

    Returns:
        Serialized JSON control frame
    """
    return json.dumps(
        {"type": "error", "message": message, "reason": reason, "retryable": retryable}
    )


@pytest.mark.parametrize("reason", sorted(RETRYABLE_RELAY_REASONS))
def test_retryable_rejection_keeps_reconnection_armed(reason: str) -> None:
    """A busy relay must not disable the fallback path for the session."""
    client = _client()

    terminal = client._handle_control_message(_error_frame(reason, retryable=True))

    assert terminal is False
    assert client.should_reconnect is True
    assert client.last_rejection is not None
    assert client.last_rejection.retryable is True
    assert client.last_rejection.reason == reason


@pytest.mark.parametrize("reason", sorted(AUTH_RELAY_REASONS))
def test_terminal_auth_rejection_stops_reconnection(reason: str) -> None:
    """Credentials the relay refuses cannot be fixed by retrying."""
    client = _client()

    terminal = client._handle_control_message(_error_frame(reason, retryable=False))

    assert terminal is True
    assert client.should_reconnect is False
    assert client.last_rejection is not None
    assert client.last_rejection.retryable is False


def test_terminal_non_auth_rejection_stops_reconnection() -> None:
    """An out-of-date client is terminal, but not an authentication failure."""
    client = _client()

    terminal = client._handle_control_message(
        _error_frame("unsupported-client", retryable=False, message="Update your Lem client")
    )

    assert terminal is True
    assert client.should_reconnect is False
    assert client.last_rejection is not None
    described = client.last_rejection.describe()
    assert "Update your Lem client" in described
    assert "Re-authentication" not in described


def test_capacity_rejection_is_not_described_as_an_auth_failure() -> None:
    """The user-visible wording must not send them to the login page."""
    rejection = RelayRejection("relay-at-capacity", "Relay is at capacity", retryable=True)

    described = rejection.describe()

    assert "Retrying" in described
    assert "Re-authentication" not in described
    assert "credentials" not in described


def test_retryable_field_wins_over_the_reason_table() -> None:
    """The relay's explicit boolean is authoritative, not our local list."""
    client = _client()

    # A reason this client has never heard of, marked retryable on the frame.
    terminal = client._handle_control_message(_error_frame("some-future-reason", retryable=True))

    assert terminal is False
    assert client.should_reconnect is True


def test_missing_retryable_field_falls_back_to_the_reason_table() -> None:
    """An older relay that omits the boolean still classifies correctly."""
    client = _client()

    terminal = client._handle_control_message(
        json.dumps({"type": "error", "message": "busy", "reason": "relay-at-capacity"})
    )

    assert terminal is False
    assert client.should_reconnect is True


def test_error_frame_without_a_reason_is_treated_as_terminal() -> None:
    """Unclassified rejections keep the old, safe behaviour."""
    client = _client()

    terminal = client._handle_control_message(json.dumps({"type": "error", "message": "nope"}))

    assert terminal is True
    assert client.should_reconnect is False


@pytest.mark.parametrize("raw", ["not json", '{"type": "connected"}', "[]"])
def test_non_error_control_frames_do_not_stop_reconnection(raw: str) -> None:
    """Only an error frame classifies the connection."""
    client = _client()

    assert client._handle_control_message(raw) is False
    assert client.should_reconnect is True
    assert client.last_rejection is None


class _ClosedSocket:
    """Stand-in for a closed aiohttp WebSocket carrying a close code."""

    def __init__(self, close_code: int | None) -> None:
        """Initialize the stub.

        Args:
            close_code: Code the relay closed with
        """
        self.close_code = close_code


def test_close_code_1008_without_a_frame_stops_reconnection() -> None:
    """The socket can drop before the error frame arrives."""
    client = _client()
    client.ws = _ClosedSocket(1008)  # type: ignore[assignment]  # stub: only close_code is read

    client._apply_close_code()

    assert client.should_reconnect is False


def test_close_code_1013_without_a_frame_keeps_reconnection_armed() -> None:
    """1013 is "try again later"; retrying is the correct response."""
    client = _client()
    client.ws = _ClosedSocket(1013)  # type: ignore[assignment]  # stub: only close_code is read

    client._apply_close_code()

    assert client.should_reconnect is True


def test_error_frame_wins_over_a_later_close_code() -> None:
    """A retryable frame is not re-decided by whatever code the socket carries."""
    client = _client()
    client._handle_control_message(_error_frame("relay-at-capacity", retryable=True))
    client.ws = _ClosedSocket(1008)  # type: ignore[assignment]  # stub: only close_code is read

    client._apply_close_code()

    assert client.should_reconnect is True
