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

"""Streaming HTTP proxy handler for the tunnel (protocol v3).

Receives request frames over the DataChannel or relay socket, forwards them to
the local Lem server or a client UI, and *emits* response frames as the upstream
produces bytes. v2 returned one blob per request, which meant nothing could
stream and any response over the DataChannel's ~64 KiB message limit killed the
channel.

Everything in a request frame is chosen by the remote peer, so the path is
validated and joined (never concatenated) onto the routed base URL, and the
forwarded headers are filtered. Without that, a peer could turn this handler
into an open proxy onto the loopback interface, the LAN, or a cloud metadata
endpoint.

The handler also presents the local server's own credentials upstream, which is
only sound for a peer that has been authorized. It therefore refuses to proxy
anything until :meth:`HTTPProxyHandler.authorize_peer` has been called with a
peer that passed ``app.tunnel.peer_auth``.

Body size is bounded by three independent layers (spec section 5.5.1), because
v3 splits a body across an open-ended series of individually-legal chunks:

1. ``http_frame.deserialize_*`` caps ``headers_len`` and ``path_len``.
2. ``http_frame.deserialize_chunk`` caps one frame's ``payload_len``.
3. :class:`RequestIntake` accumulates ``received`` across every chunk of one
   ``request_id`` and is checked **before** each append. A per-frame check
   cannot bound a multi-frame total; without this layer a peer sends unlimited
   48 KiB chunks under one id and nothing rejects it.
"""

import asyncio
import json
import logging
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

import aiohttp
from yarl import URL

from app.security import CLIENT_HEADER, get_api_token

from .errors import TunnelErrorCode, TunnelProtocolError
from .http_frame import (
    MAX_BODY_BYTES,
    MAX_CHUNK_BYTES,
    MAX_INFLIGHT_REQUESTS,
    POST_CANCEL_DRAIN_BYTES,
    HeaderList,
    deserialize_cancel,
    deserialize_chunk,
    deserialize_request_head,
    peek_request_id,
    serialize_cancel,
    serialize_response_chunk,
    serialize_response_head,
)
from .peer_auth import UNVERIFIED_PEER_LABEL, unverified_peers_allowed
from .router import (
    SERVICE_HEADER,
    RequestRouter,
    UnknownServiceError,
    create_router_with_client_discovery,
)

logger = logging.getLogger(__name__)

# Headers that describe a single hop and must not be forwarded (RFC 7230 6.1),
# plus headers that would let a peer retarget or desynchronize the upstream
# request (Host), and headers aiohttp must recompute for the body it sends.
HOP_BY_HOP_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "host",
        "content-length",
    }
)

# Headers the proxy sets itself or consumes; a peer-supplied value never
# reaches upstream. X-Lem-Service is routing metadata: the router reads it and
# it is stripped here, so a peer cannot smuggle its own value through to an app.
PROXY_CONTROLLED_HEADERS = frozenset(
    {CLIENT_HEADER, SERVICE_HEADER, "authorization", "origin", "referer"}
)

# Response headers that must not cross back to the peer: single-hop framing, and
# anything that would hand the peer upstream state. Content-Length and
# Content-Encoding are recomputed by the frame (aiohttp already decoded the
# body), so relaying the upstream values would misdescribe what the peer gets.
#
# ``set-cookie`` is deliberately **absent**, and this is load-bearing even
# though nothing consumes it yet. **Do not "clean up" this relay as unused.**
#
# It was blocked here until #72, and the consequence was concrete: no framed app
# could log in, because its session cookie never reached the browser. It now
# crosses the tunnel verbatim.
#
# The browser side does *not* act on it. The Service Worker rewrite #72
# originally specified turned out to be undeliverable - ``Set-Cookie`` is a
# forbidden response-header name, so a worker-synthesised ``Response`` cannot
# carry it (spec section 5.6.2). The design that replaces it has the worker keep
# its own cookie jar, and that jar reads the header from *these* frames. Strip
# it here and the jar has nothing to read: this relay is its prerequisite.
#
# ``set-cookie2`` stays blocked: RFC 6265 obsoleted RFC 2965, its attribute
# grammar is a different (quoted) one, and no upstream this proxy fronts emits
# it.
RESPONSE_BLOCKED_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-length",
        "content-encoding",
        "set-cookie2",
    }
)

# Longest peer-supplied path accepted. The wire format's uint16 path_len already
# bounds this; the explicit cap keeps the invariant local to the validator.
MAX_PATH_LENGTH = 8192

# Generic text returned to the peer; the real reason goes to the server log only.
GENERIC_PROXY_ERROR = "Proxy error"
GENERIC_GATEWAY_ERROR = "Bad gateway"
GENERIC_PEER_UNAUTHORIZED = "Peer not authorized"
GENERIC_TOO_LARGE = "Payload too large"
GENERIC_UNKNOWN_SERVICE = "Unknown service"


def validate_path(path: str) -> str:
    """Validate a peer-supplied request path.

    Args:
        path: Path (with optional query string) from the request frame

    Returns:
        The validated path

    Raises:
        ValueError: If the path could resolve to a host other than the target

    Examples:
        A path of ``@evil.example.com/v1/admin`` concatenated onto
        ``http://localhost:5142`` yields
        ``http://localhost:5142@evil.example.com/v1/admin`` - userinfo, not a
        host, so the request goes to evil.example.com. A path of
        ``//evil.example.com/x`` is protocol-relative and does the same.
        Both are rejected here.
    """
    if len(path) > MAX_PATH_LENGTH:
        raise ValueError("Path is too long")
    if not path.startswith("/"):
        raise ValueError("Path must start with '/'")
    if path.startswith("//") or path.startswith("/\\"):
        raise ValueError("Path must not start with a network-path reference")
    if any(ord(char) <= 0x20 or ord(char) == 0x7F for char in path):
        raise ValueError("Path must not contain whitespace or control characters")
    return path


def build_target_url(base_url: str, path: str) -> URL:
    """Join a validated path onto a base URL without letting it change the host.

    Args:
        base_url: Routed target base URL
        path: Peer-supplied path (validated by :func:`validate_path`)

    Returns:
        Absolute URL to request

    Raises:
        ValueError: If the path is invalid or the join changed the origin
    """
    base = URL(base_url)
    url = base.join(URL(validate_path(path)))

    # Defense in depth: yarl's join must not have moved us off the target.
    if (url.scheme, url.host, url.port) != (base.scheme, base.host, base.port):
        raise ValueError("Path resolved to a different origin")
    return url


def filter_request_headers(headers: Iterable[tuple[str, str]]) -> HeaderList:
    """Drop hop-by-hop and proxy-controlled headers from a peer's request.

    Args:
        headers: Peer-supplied header pairs, in order

    Returns:
        Header pairs safe to forward upstream, order and duplicates preserved
    """
    return [
        (name, value)
        for name, value in headers
        if name.lower() not in HOP_BY_HOP_HEADERS and name.lower() not in PROXY_CONTROLLED_HEADERS
    ]


def filter_response_headers(headers: Iterable[tuple[str, str]]) -> HeaderList:
    """Drop hop-by-hop and upstream-state headers before relaying to the peer.

    The mirror of :func:`filter_request_headers`: without it the peer receives
    whatever the upstream sent, including internal debug headers.

    ``Set-Cookie`` crosses (#72). Every one of them: they are not foldable into
    a single header, which is precisely why this takes pairs rather than a
    mapping. Nothing consumes them on the browser side *yet* - see the note on
    ``RESPONSE_BLOCKED_HEADERS`` above and spec section 5.6.2 - but the cookie
    jar that will consume them reads them from these frames.

    Takes pairs rather than a mapping, and is fed from aiohttp's ``CIMultiDict``
    via ``.items()``. ``dict(response.headers)`` - what v2 did - collapses every
    repeated header to its last value.

    Args:
        headers: Upstream response header pairs, in order

    Returns:
        Header pairs safe to relay back over the tunnel
    """
    return [
        (name, value) for name, value in headers if name.lower() not in RESPONSE_BLOCKED_HEADERS
    ]


def error_body(message: str) -> bytes:
    """Build a JSON error body.

    Uses json.dumps so a message containing a quote or backslash cannot break
    out of the JSON string and produce a malformed frame.

    Args:
        message: Client-facing message

    Returns:
        JSON document as UTF-8 bytes
    """
    return json.dumps({"error": message}).encode("utf-8")


@dataclass
class RequestIntake:
    """Partially-received request, one per in-flight ``request_id``.

    ``received`` is the accumulator of spec section 5.5.1: the running total of
    payload bytes across every chunk of this request. It is checked *before*
    each append, so the frame that breaches the cap is never retained and peak
    memory for one id is ``MAX_BODY_BYTES + MAX_CHUNK_BYTES``.
    """

    method: str
    path: str
    headers: HeaderList
    chunks: list[bytes] = field(default_factory=list)
    received: int = 0


class HTTPProxyHandler:
    """Streaming HTTP proxy handler for tunnel frames.

    Forwards HTTP requests to the local server or client UIs based on routing
    rules, and emits ``HTTP_RESPONSE_HEAD`` + ``HTTP_RESPONSE_CHUNK`` frames as
    the upstream produces bytes.
    """

    def __init__(
        self,
        local_server_url: str = "http://localhost:5142",
        router: RequestRouter | None = None,
        send_frame: Callable[[bytes], Awaitable[None]] | None = None,
        close_channel: Callable[[int, str], Awaitable[None]] | None = None,
    ) -> None:
        """Initialize HTTP proxy handler.

        Args:
            local_server_url: Base URL of local Lem server (used if router not provided)
            router: Optional custom router for advanced routing logic
            send_frame: Async callable that puts one frame on the transport
            close_channel: Async callable that closes the channel with a code
                and reason, for peer-behaviour violations
        """
        self.local_server_url = local_server_url.rstrip("/")
        self.router = router or create_router_with_client_discovery(local_server_url)
        self.session: aiohttp.ClientSession | None = None
        self.send_frame = send_frame
        self.close_channel = close_channel

        # Negotiated limits. Defaults stand until HELLO says otherwise; a peer
        # enforces its own caps regardless of what the other side advertised.
        self.effective_max_chunk = MAX_CHUNK_BYTES
        self.peer_max_body_bytes = MAX_BODY_BYTES

        # In-flight state, all bounded by MAX_INFLIGHT_REQUESTS.
        self.intakes: dict[int, RequestIntake] = {}
        self.tasks: dict[int, asyncio.Task[None]] = {}
        # request_id -> bytes seen since teardown. Ordered so the oldest entry
        # is the one evicted when the map is full.
        self.tombstoned: OrderedDict[int, int] = OrderedDict()

        # No peer is trusted until one is authorized. The escape hatch is the
        # only way this starts out non-None.
        self.authorized_peer: str | None = (
            UNVERIFIED_PEER_LABEL if unverified_peers_allowed() else None
        )

    def authorize_peer(self, device_id: str) -> None:
        """Record the peer this proxy may act on behalf of.

        Called only after ``app.tunnel.peer_auth`` authorized the peer. Until
        then every request is refused, so a DataChannel opened by an unknown
        peer reaches nothing.

        Args:
            device_id: Verified device ID of the peer
        """
        self.authorized_peer = device_id
        logger.info(f"Tunnel proxy authorized for peer {device_id}")

    def revoke_peer(self) -> None:
        """Forget the authorized peer (on disconnect or denial).

        Returns the handler to its starting posture, which is "deny" unless the
        operator set the escape hatch.
        """
        if self.authorized_peer is not None:
            logger.info(f"Tunnel proxy no longer authorized for peer {self.authorized_peer}")
        self.authorized_peer = UNVERIFIED_PEER_LABEL if unverified_peers_allowed() else None

    def set_send_frame(self, send_frame: Callable[[bytes], Awaitable[None]]) -> None:
        """Point the handler at a transport.

        Args:
            send_frame: Async callable that puts one frame on the transport
        """
        self.send_frame = send_frame

    def negotiate_limits(self, peer_max_chunk_bytes: int, peer_max_body_bytes: int) -> None:
        """Apply the peer's advertised limits from HELLO.

        Both are clamped with ``min``: a peer may only lower what this side
        accepts, never raise it.

        Args:
            peer_max_chunk_bytes: Largest chunk the peer will accept
            peer_max_body_bytes: Largest total body the peer will accept
        """
        self.effective_max_chunk = max(1, min(MAX_CHUNK_BYTES, peer_max_chunk_bytes))
        self.peer_max_body_bytes = min(MAX_BODY_BYTES, peer_max_body_bytes)
        logger.info(
            f"Negotiated tunnel limits: chunk={self.effective_max_chunk} "
            f"body={self.peer_max_body_bytes}"
        )

    async def start(self) -> None:
        """Start the proxy handler (create HTTP session)."""
        self.session = aiohttp.ClientSession()
        logger.info(f"HTTP proxy handler started (target: {self.local_server_url})")

    async def stop(self) -> None:
        """Stop the proxy handler (cancel work, close HTTP session)."""
        for task in list(self.tasks.values()):
            task.cancel()
        self.tasks.clear()
        self.intakes.clear()
        self.tombstoned.clear()

        if self.session and not self.session.closed:
            await self.session.close()
            self.session = None
        logger.info("HTTP proxy handler stopped")

    # -- frame ingress ------------------------------------------------------

    async def handle_request_head(self, data: bytes) -> None:
        """Handle an HTTP_REQUEST_HEAD frame.

        Args:
            data: Binary frame
        """
        if self.session is None:
            raise RuntimeError("HTTP session not started")

        try:
            frame = deserialize_request_head(data)
        except TunnelProtocolError as exc:
            await self._fail_undecodable(data, exc)
            return

        request_id = frame["request_id"]

        if request_id in self.intakes or request_id in self.tasks:
            logger.warning(f"Duplicate HTTP_REQUEST_HEAD for request {request_id}")
            await self._fail_request(
                request_id, 502, GENERIC_PROXY_ERROR, TunnelErrorCode.E_PROTO_MALFORMED
            )
            return

        # Peer-chosen ids: an unbounded map is an unbounded memory commitment.
        if len(self.intakes) + len(self.tasks) >= MAX_INFLIGHT_REQUESTS:
            logger.error(
                f"Peer exceeded MAX_INFLIGHT_REQUESTS ({MAX_INFLIGHT_REQUESTS}); closing channel"
            )
            await self._fail_request(
                request_id, 502, GENERIC_TOO_LARGE, TunnelErrorCode.E_TOO_LARGE
            )
            await self._close_channel(4006, "too many in-flight requests")
            return

        logger.info(f"Received request {request_id}: {frame['method']} {frame['path']}")

        intake = RequestIntake(
            method=frame["method"],
            path=frame["path"],
            headers=frame["headers"],
        )

        if not frame["body_follows"]:
            await self._dispatch(request_id, intake)
            return

        self.intakes[request_id] = intake

    async def handle_request_chunk(self, data: bytes) -> None:
        """Handle an HTTP_REQUEST_CHUNK frame.

        Args:
            data: Binary frame
        """
        try:
            frame = deserialize_chunk(data, self.effective_max_chunk)
        except TunnelProtocolError as exc:
            await self._fail_undecodable(data, exc)
            return

        request_id = frame["request_id"]
        payload = frame["payload"]

        # 0. A chunk for an id we already tore down: count it, never buffer it.
        if request_id in self.tombstoned:
            self.tombstoned[request_id] += len(payload)
            self.tombstoned.move_to_end(request_id)
            if self.tombstoned[request_id] > POST_CANCEL_DRAIN_BYTES:
                logger.error(
                    f"Peer kept streaming {self.tombstoned[request_id]} bytes on cancelled "
                    f"request {request_id}; closing channel"
                )
                del self.tombstoned[request_id]
                await self._close_channel(4006, "peer ignored cancellation")
                return
            if frame["final"]:
                del self.tombstoned[request_id]
            return

        intake = self.intakes.get(request_id)
        if intake is None:
            # A CHUNK with no preceding HEAD is malformed, not merely unknown.
            logger.warning(f"HTTP_REQUEST_CHUNK for unknown request {request_id}")
            await self._fail_request(
                request_id, 502, GENERIC_PROXY_ERROR, TunnelErrorCode.E_PROTO_MALFORMED
            )
            return

        # 1. THE CHECK. Before the append, on the running total, not this frame.
        if intake.received + len(payload) > self.peer_max_body_bytes:
            await self._reject_oversize(request_id, intake, len(payload))
            return

        # 2. Only now is it safe to retain the bytes.
        intake.received += len(payload)
        intake.chunks.append(payload)

        if frame["final"]:
            del self.intakes[request_id]
            await self._dispatch(request_id, intake)

    async def handle_cancel(self, data: bytes) -> None:
        """Handle an HTTP_CANCEL frame from the peer.

        Args:
            data: Binary frame
        """
        try:
            frame = deserialize_cancel(data)
        except TunnelProtocolError as exc:
            logger.warning(f"Undecodable HTTP_CANCEL: {exc}")
            return

        request_id = frame["request_id"]
        logger.info(f"Peer cancelled request {request_id} (reason {frame['reason_code']})")

        self.intakes.pop(request_id, None)
        task = self.tasks.pop(request_id, None)
        if task is not None:
            task.cancel()
        self._tombstone(request_id)

    # -- dispatch and egress ------------------------------------------------

    async def _dispatch(self, request_id: int, intake: RequestIntake) -> None:
        """Start forwarding a fully-received request.

        Args:
            request_id: Exchange id
            intake: Received request
        """
        task = asyncio.create_task(self._stream_response(request_id, intake))
        self.tasks[request_id] = task

    async def _stream_response(self, request_id: int, intake: RequestIntake) -> None:
        """Forward one request upstream and stream the response back.

        Args:
            request_id: Exchange id
            intake: Fully-received request
        """
        try:
            await self._forward_request(request_id, intake)
        except asyncio.CancelledError:
            logger.info(f"Request {request_id} cancelled")
            raise
        except aiohttp.ClientError as exc:
            logger.error(f"HTTP client error: {exc}")
            await self._fail_request(
                request_id, 502, GENERIC_GATEWAY_ERROR, TunnelErrorCode.E_UPSTREAM
            )
        except Exception as exc:
            logger.error(f"Unexpected error forwarding request: {exc}")
            await self._fail_request(
                request_id, 500, GENERIC_PROXY_ERROR, TunnelErrorCode.E_INTERNAL
            )
        finally:
            self.tasks.pop(request_id, None)

    async def _forward_request(self, request_id: int, intake: RequestIntake) -> None:
        """Forward a request upstream, emitting response frames as bytes arrive.

        Args:
            request_id: Exchange id
            intake: Fully-received request

        Raises:
            RuntimeError: If the HTTP session is not started
        """
        if self.session is None:
            raise RuntimeError("HTTP session not started")

        # Nothing is proxied for a peer we never authorized: this handler
        # presents the local server's own credentials, so an unverified peer
        # must not get to use it at all.
        if self.authorized_peer is None:
            logger.warning(
                f"Refused tunnel request from an unauthorized peer: {intake.method} {intake.path!r}"
            )
            await self._fail_request(request_id, 403, GENERIC_PEER_UNAUTHORIZED)
            return

        # Use router to determine target. An X-Lem-Service header that does not
        # resolve exactly is refused here; it never falls through to the local
        # server, which would hand a mistyped service id the privileged local
        # API together with the credentials appended below.
        try:
            target_url = self.router.route(intake.path, intake.headers)
        except UnknownServiceError as exc:
            logger.warning(
                f"Rejected tunnel request {request_id} for service {exc.service_id!r}: "
                f"not running or not exactly resolvable ({intake.method} {intake.path})"
            )
            await self._fail_request(
                request_id, 502, GENERIC_UNKNOWN_SERVICE, TunnelErrorCode.E_UNKNOWN_SERVICE
            )
            return

        # Build full URL from a validated path (never string concatenation)
        try:
            url = build_target_url(target_url, intake.path)
        except ValueError as exc:
            logger.warning(f"Rejected proxy request path {intake.path!r}: {exc}")
            await self._fail_request(request_id, 400, "Invalid request path")
            return

        headers = filter_request_headers(intake.headers)
        # The peer got past the authorization gate above, so the tunnel may
        # present the local server's own credentials on its behalf.
        if str(url.origin()) == str(URL(self.local_server_url).origin()):
            headers.append((CLIENT_HEADER, "lem-tunnel"))
            token = get_api_token()
            if token is not None:
                headers.append(("Authorization", f"Bearer {token}"))

        kwargs: dict[str, Any] = {
            "headers": headers,
            "timeout": aiohttp.ClientTimeout(total=30),
            # Redirects are relayed to the peer, never followed here: following
            # one would let an upstream Location header pick a new host.
            "allow_redirects": False,
        }

        body = b"".join(intake.chunks)
        if body:
            kwargs["data"] = body

        cap = min(MAX_BODY_BYTES, self.peer_max_body_bytes)

        async with self.session.request(intake.method, url, **kwargs) as response:
            # The clean case: an over-cap response is refused before a byte of
            # it is streamed.
            declared = response.content_length
            if declared is not None and declared > cap:
                logger.warning(
                    f"Upstream declared {declared} bytes for request {request_id} "
                    f"({intake.method} {intake.path}), over the {cap} byte cap"
                )
                await self._fail_request(
                    request_id, 502, GENERIC_TOO_LARGE, TunnelErrorCode.E_TOO_LARGE
                )
                return

            await self._send(
                serialize_response_head(
                    {
                        "request_id": request_id,
                        "status_code": response.status,
                        "headers": filter_response_headers(response.headers.items()),
                        "body_follows": True,
                    }
                )
            )

            sent = 0
            async for chunk in response.content.iter_chunked(self.effective_max_chunk):
                sent += len(chunk)
                if sent > cap:
                    # Status 200 is already committed; the only honest ending is
                    # a failure. No FINAL chunk - that would tell the peer the
                    # body was complete, which is silent truncation.
                    response.close()
                    await self._send(serialize_cancel(request_id, TunnelErrorCode.E_TOO_LARGE))
                    logger.warning(
                        f"Upstream streamed past the {cap} byte cap for request {request_id} "
                        f"({intake.method} {intake.path}); cancelled at {sent} bytes"
                    )
                    return
                await self._send(serialize_response_chunk(request_id, chunk, final=False))

            await self._send(serialize_response_chunk(request_id, b"", final=True))
            logger.info(f"Sent response {request_id}: {response.status} ({sent} bytes)")

    # -- failure paths ------------------------------------------------------

    async def _fail_request(
        self,
        request_id: int,
        status_code: int,
        message: str,
        reason_code: TunnelErrorCode | None = None,
    ) -> None:
        """Answer one exchange with a generic error body.

        Args:
            request_id: Exchange id
            status_code: HTTP status to report
            message: Generic client-facing message
            reason_code: Optional cancel reason to follow the response with
        """
        await self._send(
            serialize_response_head(
                {
                    "request_id": request_id,
                    "status_code": status_code,
                    "headers": [("Content-Type", "application/json")],
                    "body_follows": True,
                }
            )
        )
        await self._send(serialize_response_chunk(request_id, error_body(message), final=True))
        if reason_code is not None:
            # Response frames first, so a peer that stops reading on CANCEL
            # still gets a diagnosable answer.
            await self._send(serialize_cancel(request_id, reason_code))

    async def _fail_undecodable(self, data: bytes, exc: TunnelProtocolError) -> None:
        """Answer a frame that failed to decode.

        Args:
            data: The raw frame
            exc: The decode failure
        """
        request_id = peek_request_id(data)
        logger.warning(f"Rejected malformed frame: {exc}")
        if request_id is None or request_id == 0:
            # Undiagnosable: an error addressed to id 0 would be dropped by the
            # peer anyway, and inventing an id is worse than saying nothing.
            return
        await self._fail_request(request_id, exc.http_status, GENERIC_PROXY_ERROR, exc.code)

    async def _reject_oversize(self, request_id: int, intake: RequestIntake, incoming: int) -> None:
        """Refuse a request whose accumulated body breached the cap.

        No upstream request is issued: the local service never sees a byte of an
        over-cap body, which is the second reason this control matters.

        Args:
            request_id: Exchange id
            intake: The partial request, dropped here
            incoming: Size of the frame that breached the cap
        """
        logger.warning(
            f"Request {request_id} ({intake.method} {intake.path}) exceeded "
            f"MAX_BODY_BYTES: {intake.received} received + {incoming} incoming > "
            f"{self.peer_max_body_bytes} (peer: {self.authorized_peer})"
        )
        # Reclaim at rejection time, not at garbage-collection time.
        self.intakes.pop(request_id, None)
        await self._fail_request(request_id, 502, GENERIC_TOO_LARGE, TunnelErrorCode.E_TOO_LARGE)
        self._tombstone(request_id)

    def _tombstone(self, request_id: int) -> None:
        """Mark an id as torn down so later chunks are dropped, not buffered.

        Args:
            request_id: Exchange id
        """
        self.tombstoned[request_id] = 0
        self.tombstoned.move_to_end(request_id)
        while len(self.tombstoned) > MAX_INFLIGHT_REQUESTS:
            # An evicted id simply behaves as a malformed chunk afterwards.
            self.tombstoned.popitem(last=False)

    # -- transport ----------------------------------------------------------

    async def _send(self, data: bytes) -> None:
        """Put one frame on the transport.

        Args:
            data: Binary frame
        """
        if self.send_frame is None:
            logger.warning("Cannot send frame: no transport attached to the HTTP proxy")
            return
        await self.send_frame(data)

    async def _close_channel(self, code: int, reason: str) -> None:
        """Close the whole channel after a peer-behaviour violation.

        Args:
            code: WebSocket-space close code
            reason: Generic reason
        """
        if self.close_channel is None:
            logger.error(f"Channel close requested ({code} {reason}) but no closer is attached")
            return
        await self.close_channel(code, reason)
