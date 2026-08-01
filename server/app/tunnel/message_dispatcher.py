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

"""Message dispatcher for routing tunnel frames by type, and HELLO negotiation.

Routes incoming binary frames to the right handler:

- 0x00 HELLO               -> version negotiation (here)
- 0x01 HTTP_REQUEST_HEAD   -> HTTPProxyHandler
- 0x02 (reserved, v2)      -> loud protocol error; the peer speaks v2
- 0x05 HTTP_CANCEL         -> HTTPProxyHandler
- 0x06 HTTP_REQUEST_CHUNK  -> HTTPProxyHandler
- 0x10/0x11/0x12 WS_*      -> WSProxyHandler

Negotiation (spec section 5.8): each peer sends HELLO as the first frame on a
newly opened channel and MUST NOT act on any other frame until the peer's HELLO
has been validated. Frames arriving before it are queued, bounded, and replayed
after. If no HELLO arrives within :data:`HELLO_TIMEOUT_SECONDS` the peer is v2
or older and the channel is closed with 4001 rather than exchanging bytes that
would be misparsed.

A v2 peer cannot be corrupted by this: v3's first frame is 0x00, which v2's
dispatcher rejects outright, and v2's response frame 0x02 is reserved here.
**A v2 peer sends no HELLO at all** - it has no such frame - so the timeout, not
a version field, is what actually detects it. The version check only catches a
future v4.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable

from .errors import TunnelErrorCode
from .http_frame import (
    MAX_BODY_BYTES,
    MAX_CHUNK_BYTES,
    PROTOCOL_VERSION,
    FrameType,
    HelloFrame,
    deserialize_hello,
    serialize_hello,
)
from .http_proxy import HTTPProxyHandler
from .ws_proxy import WSProxyHandler

logger = logging.getLogger(__name__)

# How long to wait for the peer's HELLO before concluding it speaks v2.
HELLO_TIMEOUT_SECONDS = 2.0

# Frames tolerated before the peer's HELLO arrives. A peer that floods here is
# not merely early.
MAX_PRE_HELLO_QUEUE = 16

# Close code for a protocol version mismatch (spec section 7.2).
WS_CODE_PROTOCOL_VERSION = 4001

# Advertised in HELLO; diagnostics only.
IMPL_NAME = "lem-server/0.1.0"


class MessageDispatcher:
    """Dispatches tunnel messages to handlers, and owns HELLO negotiation."""

    def __init__(
        self,
        http_handler: HTTPProxyHandler,
        ws_handler: WSProxyHandler,
        send_frame: Callable[[bytes], Awaitable[None]] | None = None,
        close_channel: Callable[[int, str], Awaitable[None]] | None = None,
    ) -> None:
        """Initialize message dispatcher.

        Args:
            http_handler: HTTP proxy handler
            ws_handler: WebSocket proxy handler
            send_frame: Async callable that puts one frame on the transport
            close_channel: Async callable that closes the channel with a code
                and reason
        """
        self.http_handler = http_handler
        self.ws_handler = ws_handler
        self.send_frame = send_frame
        self.close_channel = close_channel

        self.peer_hello: HelloFrame | None = None
        self.hello_sent = False
        self.negotiation_failed = False
        self._pending: list[bytes] = []
        self._hello_timer: asyncio.Task[None] | None = None

    @property
    def negotiated(self) -> bool:
        """Whether the peer's HELLO has been accepted.

        Returns:
            True once traffic may flow
        """
        return self.peer_hello is not None

    def attach_transport(
        self,
        send_frame: Callable[[bytes], Awaitable[None]],
        close_channel: Callable[[int, str], Awaitable[None]] | None = None,
    ) -> None:
        """Point the dispatcher and both handlers at a transport.

        Args:
            send_frame: Async callable that puts one frame on the transport
            close_channel: Async callable that closes the channel
        """
        self.send_frame = send_frame
        self.close_channel = close_channel
        self.http_handler.set_send_frame(send_frame)
        self.http_handler.close_channel = close_channel
        self.ws_handler.send_frame = send_frame

    def reset(self) -> None:
        """Forget negotiation state, for a channel that is being re-opened."""
        self.peer_hello = None
        self.hello_sent = False
        self.negotiation_failed = False
        self._pending.clear()
        if self._hello_timer is not None:
            self._hello_timer.cancel()
            self._hello_timer = None

    async def begin_negotiation(self) -> None:
        """Send our HELLO and start the timeout that detects a v2 peer.

        Called when a channel opens, before anything else is put on it.
        """
        self.reset()
        await self.send_hello()
        self._hello_timer = asyncio.create_task(self._expire_hello())

    async def send_hello(self) -> None:
        """Send this peer's HELLO frame."""
        hello: HelloFrame = {
            "protocol_version": PROTOCOL_VERSION,
            "flags": 0,
            "max_chunk_bytes": MAX_CHUNK_BYTES,
            "max_body_bytes": MAX_BODY_BYTES,
            "impl": IMPL_NAME,
        }
        if self.send_frame is None:
            logger.warning("Cannot send HELLO: no transport attached")
            return
        await self.send_frame(serialize_hello(hello))
        self.hello_sent = True
        logger.info(f"Sent HELLO (v{PROTOCOL_VERSION}, chunk={MAX_CHUNK_BYTES})")

    async def _expire_hello(self) -> None:
        """Fail the channel if the peer never sends a HELLO."""
        try:
            await asyncio.sleep(HELLO_TIMEOUT_SECONDS)
        except asyncio.CancelledError:
            return

        if self.peer_hello is not None:
            return

        self.negotiation_failed = True
        logger.error(
            "No HELLO from the peer within "
            f"{HELLO_TIMEOUT_SECONDS}s. The remote dashboard speaks an older "
            "tunnel protocol (v2). Update Lem on the machine connecting to this one."
        )
        await self._close(WS_CODE_PROTOCOL_VERSION, "protocol version mismatch")

    async def dispatch(self, data: bytes) -> None:
        """Dispatch one incoming frame.

        Args:
            data: Binary frame from the transport

        Raises:
            ValueError: If the frame is empty or the type is unknown
        """
        if len(data) < 1:
            raise ValueError("Frame too short (no frame type)")

        frame_type = data[0]
        logger.debug(f"Dispatching frame type: 0x{frame_type:02x}")

        if frame_type == FrameType.HELLO:
            await self._handle_hello(data)
            return

        if self.negotiation_failed:
            logger.debug("Dropping frame: negotiation already failed")
            return

        # A peer MUST NOT be acted on before its HELLO is validated. Queue a
        # bounded number of early frames rather than reordering the exchange.
        if self.peer_hello is None:
            if len(self._pending) >= MAX_PRE_HELLO_QUEUE:
                logger.error("Peer sent too many frames before HELLO; closing channel")
                self.negotiation_failed = True
                await self._close(WS_CODE_PROTOCOL_VERSION, "no HELLO")
                return
            self._pending.append(data)
            return

        await self._route(data)

    async def _handle_hello(self, data: bytes) -> None:
        """Validate the peer's HELLO and release any queued frames.

        Args:
            data: Binary HELLO frame
        """
        if self._hello_timer is not None:
            self._hello_timer.cancel()
            self._hello_timer = None

        try:
            hello = deserialize_hello(data)
        except ValueError as exc:
            logger.error(f"Malformed HELLO from peer: {exc}")
            self.negotiation_failed = True
            await self._close(WS_CODE_PROTOCOL_VERSION, "malformed HELLO")
            return

        if hello["protocol_version"] != PROTOCOL_VERSION:
            logger.error(
                f"Peer speaks tunnel protocol v{hello['protocol_version']}, "
                f"this server speaks v{PROTOCOL_VERSION} ({hello['impl']!r}). "
                "Update whichever side is older."
            )
            self.negotiation_failed = True
            await self._close(WS_CODE_PROTOCOL_VERSION, "protocol version mismatch")
            return

        self.peer_hello = hello
        # Each side enforces its own caps; the negotiated value is the minimum.
        self.http_handler.negotiate_limits(hello["max_chunk_bytes"], hello["max_body_bytes"])
        self.ws_handler.negotiate_limits(hello["max_chunk_bytes"])
        logger.info(
            f"Peer HELLO accepted: v{hello['protocol_version']} {hello['impl']!r} "
            f"chunk={hello['max_chunk_bytes']} body={hello['max_body_bytes']}"
        )

        queued = self._pending
        self._pending = []
        for frame in queued:
            await self._route(frame)

    async def _route(self, data: bytes) -> None:
        """Route a post-negotiation frame to its handler.

        Args:
            data: Binary frame

        Raises:
            ValueError: If the frame type is unknown
        """
        frame_type = data[0]

        if frame_type == FrameType.HTTP_REQUEST_HEAD:
            await self.http_handler.handle_request_head(data)

        elif frame_type == FrameType.HTTP_REQUEST_CHUNK:
            await self.http_handler.handle_request_chunk(data)

        elif frame_type == FrameType.HTTP_CANCEL:
            await self.http_handler.handle_cancel(data)

        elif frame_type == FrameType.HTTP_RESPONSE_V2_RESERVED:
            # A v2 peer's response frame. Diagnosable precisely because 0x02 was
            # reserved rather than reused.
            logger.error(
                f"Received a reserved v2 HTTP_RESPONSE frame "
                f"({TunnelErrorCode.E_PROTO_V2_FRAME.name}); the peer speaks v2"
            )
            self.negotiation_failed = True
            await self._close(WS_CODE_PROTOCOL_VERSION, "peer speaks protocol v2")

        elif frame_type in (FrameType.HTTP_RESPONSE_HEAD, FrameType.HTTP_RESPONSE_CHUNK):
            logger.warning(f"Received response frame 0x{frame_type:02x} from peer (unexpected)")

        elif frame_type == FrameType.WS_CONNECT:
            await self.ws_handler.handle_connect(data)

        elif frame_type == FrameType.WS_DATA:
            await self.ws_handler.handle_data(data)

        elif frame_type == FrameType.WS_CLOSE:
            await self.ws_handler.handle_close(data)

        elif frame_type in (FrameType.WS_CONNECT_ACK, FrameType.WS_CONNECT_ERROR):
            logger.warning(f"Received handshake frame 0x{frame_type:02x} from peer (unexpected)")

        else:
            raise ValueError(f"Unknown frame type: 0x{frame_type:02x}")

    async def _close(self, code: int, reason: str) -> None:
        """Close the channel, if a closer is attached.

        Args:
            code: Close code
            reason: Generic reason
        """
        if self.close_channel is None:
            logger.error(f"Channel close requested ({code} {reason}) but no closer is attached")
            return
        await self.close_channel(code, reason)
