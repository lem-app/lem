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

The classifier is only half the fix. The bug this file exists for was that the
receive loop *ignored text frames entirely*, so a perfectly correct classifier
was never reached. Unit tests that call ``_handle_control_message`` directly
cannot see that: reintroducing the historical defect leaves every one of them
green. ``TestRealReceiveLoop`` therefore drives ``aiohttp`` messages through
the real ``_handle_messages()`` loop instead, which is the wiring that broke.
"""

import json
from collections.abc import AsyncIterator

import aiohttp
import pytest

from app.tunnel.relay_client import (
    AUTH_RELAY_REASONS,
    RETRYABLE_RELAY_REASONS,
    RelayClient,
    RelayConnectionState,
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


class _ScriptedSocket:
    """Stand-in for ``aiohttp.ClientWebSocketResponse`` that replays a script.

    ``_handle_messages`` consumes the socket with ``async for``, so anything
    that wants to test the *wiring* - as opposed to the classifier the wiring
    calls - has to be iterable in exactly that way. The messages are real
    :class:`aiohttp.WSMessage` instances so the ``msg.type`` comparisons under
    test are the production ones.
    """

    def __init__(self, messages: list[aiohttp.WSMessage], close_code: int | None = None) -> None:
        """Initialize the scripted socket.

        Args:
            messages: Frames to deliver, in order, before the iterator ends
            close_code: Code readable after the iterator is exhausted
        """
        self.messages = messages
        self.close_code = close_code
        self.closed = False

    def __aiter__(self) -> AsyncIterator[aiohttp.WSMessage]:
        """Iterate the scripted messages.

        Returns:
            Async iterator over the script
        """
        return self._replay()

    async def _replay(self) -> AsyncIterator[aiohttp.WSMessage]:
        """Yield each scripted message once.

        Yields:
            The next scripted message
        """
        for message in self.messages:
            yield message


def _text(payload: str) -> aiohttp.WSMessage:
    """Build a real text WebSocket message.

    Args:
        payload: Frame body

    Returns:
        Message the receive loop will see as ``WSMsgType.TEXT``
    """
    return aiohttp.WSMessage(aiohttp.WSMsgType.TEXT, payload, "")


class TestRealReceiveLoop:
    """Drive rejections through ``_handle_messages``, not the classifier.

    ``relay_client.py``'s historical bug was in this loop: the ``TEXT`` branch
    did not exist, so error frames were dropped before any classification
    happened. A test that calls ``_handle_control_message`` directly stays
    green against that defect. These do not.
    """

    @staticmethod
    def _armed(
        client: RelayClient,
        monkeypatch: pytest.MonkeyPatch,
        messages: list[aiohttp.WSMessage],
        close_code: int | None = None,
    ) -> list[bool]:
        """Point the client at a scripted socket and trap its reconnects.

        ``_handle_reconnect`` itself is left real, so the ``should_reconnect``
        gate inside it is part of what these tests exercise; only the socket
        rebuild underneath it is stubbed out.

        Args:
            client: Client under test
            monkeypatch: Fixture used to stub the reconnect
            messages: Frames the socket delivers before the iterator ends
            close_code: Code the socket reports once exhausted

        Returns:
            List that gains an entry per real reconnection attempt
        """
        client.ws = _ScriptedSocket(messages, close_code)  # type: ignore[assignment]  # stub socket
        client.reconnect_delay = 0.0

        attempts: list[bool] = []

        async def _record() -> None:
            attempts.append(True)

        monkeypatch.setattr(client, "_reconnect_full", _record)
        return attempts

    async def test_a_terminal_error_frame_over_the_wire_stops_reconnection(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A live text frame carrying an auth failure must reach the classifier.

        This is the exact regression: with the loop's ``TEXT`` branch removed,
        the rejection is never seen, the client reports a plain close and keeps
        reconnecting forever against credentials that will never be accepted.
        """
        client = _client()
        attempts = self._armed(
            client,
            monkeypatch,
            [_text(_error_frame("auth-failed", retryable=False, message="Authentication failed"))],
        )

        await client._handle_messages()

        assert client.last_rejection is not None, "the receive loop never classified the frame"
        assert client.last_rejection.reason == "auth-failed"
        assert client.last_rejection.retryable is False
        assert client.should_reconnect is False
        assert client.get_state() is RelayConnectionState.FAILED
        assert attempts == []

    async def test_a_retryable_error_frame_over_the_wire_keeps_reconnecting(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A busy relay closing with 1013 must not disable the fallback path.

        The frame arrives first and the close follows, which is the ordering
        the relay actually produces; the frame's ``retryable`` is what decides,
        and the loop has to deliver it for that to be true.
        """
        client = _client()
        busy = _error_frame("relay-at-capacity", retryable=True, message="Relay is at capacity")
        attempts = self._armed(client, monkeypatch, [_text(busy)], close_code=1013)

        await client._handle_messages()

        assert client.last_rejection is not None, "the receive loop never classified the frame"
        assert client.last_rejection.reason == "relay-at-capacity"
        assert client.last_rejection.retryable is True
        assert client.should_reconnect is True
        assert client.get_state() is RelayConnectionState.CLOSED
        assert attempts == [True]
