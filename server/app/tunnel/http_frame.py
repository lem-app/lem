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

"""HTTP-over-DataChannel frame serialization for tunnel protocol v3.

v3 differs from v2 in four ways that matter (spec section 5.1):

* **Bodies are raw bytes, not UTF-8 text.** v2 typed the body ``str`` and
  round-tripped it through UTF-8, which corrupts every PNG, font and wasm file
  and raises outright on invalid UTF-8.
* **Responses stream.** A response is a ``HTTP_RESPONSE_HEAD`` followed by any
  number of ``HTTP_RESPONSE_CHUNK`` frames, the last carrying ``FINAL``. v2 put
  a whole response in one DataChannel message, against a ~64 KiB
  ``maxMessageSize``, so nothing could stream and any JS bundle killed the
  channel.
* **Headers are an ordered array of ``[name, value]`` pairs.** A JSON object
  collapses duplicates, which loses every ``Set-Cookie`` after the first.
* **Every declared length is checked before it is used to slice.**

Frame layouts, all integers big-endian, byte 0 always the frame type, and bytes
1..4 always the request_id for the HTTP family::

    HELLO               0x00  type(1) version(1) flags(2) max_chunk(4)
                              max_body(4) impl_len(2) impl
    HTTP_REQUEST_HEAD   0x01  type(1) request_id(4) flags(1) method_len(2)
                              method path_len(2) path headers_len(4) headers
    (reserved)          0x02  v2 HTTP_RESPONSE. Receipt is a protocol error.
    HTTP_RESPONSE_HEAD  0x03  type(1) request_id(4) status(2) flags(1)
                              headers_len(4) headers
    HTTP_RESPONSE_CHUNK 0x04  type(1) request_id(4) flags(1) payload_len(4)
                              payload
    HTTP_CANCEL         0x05  type(1) request_id(4) reason_code(2)
    HTTP_REQUEST_CHUNK  0x06  same layout as 0x04

Flags are bit sets. Undefined bits are sent as 0 and ignored on receipt.
"""

import json
import struct
from enum import IntEnum
from typing import TypedDict

from .errors import TunnelErrorCode, TunnelProtocolError

# Wire version advertised in HELLO.
PROTOCOL_VERSION = 3

# Declared lengths are uint32, so a peer can claim up to 4 GiB. Cap what we are
# willing to accept before allocating anything on its behalf.
MAX_BODY_BYTES = 32 * 1024 * 1024  # 32 MiB
MAX_HEADERS_BYTES = 256 * 1024  # 256 KiB

# Largest payload accepted in one CHUNK or WS_DATA frame. This is the *default
# advertised* value, not a protocol constant: each peer advertises its own in
# HELLO and the effective value for a channel is min(local, peer, transport).
# 48 KiB is derived from SCTP's 64 KiB interoperable floor less frame overhead;
# the relay path has no such limit and may negotiate higher (spec 5.5.2).
MAX_CHUNK_BYTES = 48 * 1024  # 49152

# Longest path or WebSocket URL accepted. Both length fields are uint16, so
# this only tightens the bound; it keeps the number in one place.
MAX_URL_BYTES = 8 * 1024

# Concurrent request_ids one channel may have open, per direction.
MAX_INFLIGHT_REQUESTS = 128

# Bytes tolerated on a request_id that has already been torn down before the
# peer is treated as ignoring cancellation and the channel is closed.
POST_CANCEL_DRAIN_BYTES = 512 * 1024

# Flag bits.
FLAG_BODY_FOLLOWS = 0x01  # HEAD frames: one or more CHUNK frames follow
FLAG_FINAL = 0x01  # CHUNK frames: last chunk of this request_id

# Headers travel as an ordered array of pairs so duplicates survive.
HeaderList = list[tuple[str, str]]


class FrameType(IntEnum):
    """Frame type constants (spec section 5.3)."""

    HELLO = 0x00
    HTTP_REQUEST_HEAD = 0x01
    # 0x02 was v2's HTTP_RESPONSE. Reserved, never sent: a v2 peer's response
    # arriving here is then unambiguously diagnosable rather than misparsed.
    HTTP_RESPONSE_V2_RESERVED = 0x02
    HTTP_RESPONSE_HEAD = 0x03
    HTTP_RESPONSE_CHUNK = 0x04
    HTTP_CANCEL = 0x05
    HTTP_REQUEST_CHUNK = 0x06
    WS_CONNECT = 0x10
    WS_DATA = 0x11
    WS_CLOSE = 0x12
    WS_CONNECT_ACK = 0x13
    WS_CONNECT_ERROR = 0x14


class HelloFrame(TypedDict):
    """Version and limit advertisement, first frame on every channel."""

    protocol_version: int
    flags: int
    max_chunk_bytes: int
    max_body_bytes: int
    impl: str


class HTTPRequestHeadFrame(TypedDict):
    """Start of a request. Carries no body; chunks follow if body_follows."""

    request_id: int
    method: str
    path: str
    headers: HeaderList
    body_follows: bool


class HTTPResponseHeadFrame(TypedDict):
    """Start of a response. Carries no body; chunks follow if body_follows."""

    request_id: int
    status_code: int
    headers: HeaderList
    body_follows: bool


class HTTPChunkFrame(TypedDict):
    """One piece of a request or response body."""

    frame_type: int
    request_id: int
    payload: bytes
    final: bool


class HTTPCancelFrame(TypedDict):
    """Abandonment of an exchange by either peer."""

    request_id: int
    reason_code: int


def _malformed(message: str) -> TunnelProtocolError:
    """Build a malformed-frame error.

    Args:
        message: Local-only detail

    Returns:
        Error carrying E_PROTO_MALFORMED
    """
    return TunnelProtocolError(TunnelErrorCode.E_PROTO_MALFORMED, message)


def peek_frame_type(data: bytes) -> int | None:
    """Read byte 0 without deserializing the rest.

    Args:
        data: Raw frame bytes

    Returns:
        Frame type, or None for an empty frame
    """
    if len(data) < 1:
        return None
    return int(data[0])


def peek_request_id(data: bytes) -> int | None:
    """Read the request_id every HTTP-family frame carries at bytes 1..4.

    Byte 0 is the frame type, so a reader that wants only the correlation id -
    an error path that could not deserialize the rest of the frame, say - must
    skip it. Reading ``data[:4]`` instead yields the frame type in the top
    octet (request_id 1 becomes 0x01000000).

    Args:
        data: Raw frame bytes

    Returns:
        The request_id, or None if the frame is too short to carry one
    """
    if len(data) < 5:
        return None
    return int(struct.unpack(">I", data[1:5])[0])


def encode_headers(headers: HeaderList) -> bytes:
    """Encode a header list as the wire's JSON array of pairs.

    ``separators`` and ``ensure_ascii`` are not cosmetic here. Python's defaults
    pad with ``", "`` and escape non-ASCII as ``\\uXXXX``; ``JSON.stringify``
    does neither. Left at their defaults, the two codecs produce *different
    bytes for the same headers* - decodable by both, but not byte-identical,
    which is exactly the drift the cross-language golden vectors exist to catch.

    Args:
        headers: Ordered header pairs

    Returns:
        UTF-8 JSON bytes
    """
    return json.dumps(
        [[name, value] for name, value in headers],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def decode_headers(raw: bytes) -> HeaderList:
    """Decode and validate the wire's JSON array of header pairs.

    The peer chooses these bytes, so the shape is checked rather than trusted:
    a JSON object (v2's encoding), a nested array, or a non-string value are all
    rejected instead of being coerced into something the proxy then forwards.

    Args:
        raw: UTF-8 JSON bytes

    Returns:
        Ordered header pairs

    Raises:
        TunnelProtocolError: If the JSON is not an array of ``[str, str]``
    """
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _malformed(f"Headers are not valid JSON: {exc}") from exc

    if not isinstance(parsed, list):
        raise _malformed("Headers must be a JSON array of [name, value] pairs")

    headers: HeaderList = []
    for entry in parsed:
        if not isinstance(entry, list) or len(entry) != 2:
            raise _malformed("Each header must be a two-element array")
        name, value = entry
        if not isinstance(name, str) or not isinstance(value, str):
            raise _malformed("Header names and values must be strings")
        headers.append((name, value))
    return headers


def _require(data: bytes, offset: int, size: int, field: str) -> None:
    """Assert the frame is long enough to read a field.

    Args:
        data: Raw frame bytes
        offset: Read position
        size: Bytes needed
        field: Field name for the error message

    Raises:
        TunnelProtocolError: If the frame is too short
    """
    if len(data) < offset + size:
        raise _malformed(f"Insufficient data for {field}")


def _check_type(data: bytes, expected: FrameType) -> None:
    """Validate the frame type byte.

    Args:
        data: Raw frame bytes
        expected: Frame type the caller is decoding

    Raises:
        TunnelProtocolError: If the frame is empty, reserved, or the wrong type
    """
    _require(data, 0, 1, "frame_type")
    frame_type = data[0]
    if frame_type == FrameType.HTTP_RESPONSE_V2_RESERVED:
        raise TunnelProtocolError(
            TunnelErrorCode.E_PROTO_V2_FRAME,
            "Received a v2 HTTP_RESPONSE frame (0x02); peer speaks protocol v2",
        )
    if frame_type != expected:
        raise _malformed(f"Expected frame 0x{expected:02x}, got 0x{frame_type:02x}")


def _read_request_id(data: bytes) -> int:
    """Read and validate the request_id at bytes 1..4.

    Args:
        data: Raw frame bytes

    Returns:
        The request_id

    Raises:
        TunnelProtocolError: If the frame is truncated or the id is 0
    """
    _require(data, 1, 4, "request_id")
    (request_id,) = struct.unpack(">I", data[1:5])
    if request_id == 0:
        raise _malformed("request_id 0 is reserved")
    return int(request_id)


def _read_headers(data: bytes, offset: int) -> tuple[HeaderList, int]:
    """Read a length-prefixed header block.

    Args:
        data: Raw frame bytes
        offset: Position of the headers_len field

    Returns:
        Decoded headers and the offset just past them

    Raises:
        TunnelProtocolError: If the block is oversized or truncated
    """
    _require(data, offset, 4, "headers_len")
    (headers_len,) = struct.unpack(">I", data[offset : offset + 4])
    offset += 4

    # Before the slice, always: the length is peer-chosen and uint32-wide.
    if headers_len > MAX_HEADERS_BYTES:
        raise _malformed(f"Headers too large: {headers_len} > {MAX_HEADERS_BYTES}")

    _require(data, offset, headers_len, "headers")
    headers = decode_headers(data[offset : offset + headers_len])
    return headers, offset + headers_len


# ---------------------------------------------------------------------------
# HELLO
# ---------------------------------------------------------------------------


def serialize_hello(frame: HelloFrame) -> bytes:
    """Serialize a HELLO frame.

    Args:
        frame: HELLO frame to serialize

    Returns:
        Binary frame
    """
    impl_bytes = frame["impl"].encode("utf-8")
    return b"".join(
        [
            struct.pack(">B", FrameType.HELLO),
            struct.pack(">B", frame["protocol_version"]),
            struct.pack(">H", frame["flags"]),
            struct.pack(">I", frame["max_chunk_bytes"]),
            struct.pack(">I", frame["max_body_bytes"]),
            struct.pack(">H", len(impl_bytes)),
            impl_bytes,
        ]
    )


def deserialize_hello(data: bytes) -> HelloFrame:
    """Deserialize a HELLO frame.

    Args:
        data: Binary frame

    Returns:
        HELLO frame

    Raises:
        TunnelProtocolError: If the frame is malformed
    """
    _check_type(data, FrameType.HELLO)
    _require(data, 1, 13, "hello header")
    protocol_version, flags, max_chunk, max_body, impl_len = struct.unpack(">BHIIH", data[1:14])

    _require(data, 14, impl_len, "impl")
    try:
        impl = data[14 : 14 + impl_len].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise _malformed("impl is not valid UTF-8") from exc

    return {
        "protocol_version": int(protocol_version),
        "flags": int(flags),
        "max_chunk_bytes": int(max_chunk),
        "max_body_bytes": int(max_body),
        "impl": impl,
    }


# ---------------------------------------------------------------------------
# HTTP_REQUEST_HEAD
# ---------------------------------------------------------------------------


def serialize_request_head(frame: HTTPRequestHeadFrame) -> bytes:
    """Serialize an HTTP_REQUEST_HEAD frame.

    Args:
        frame: Request head to serialize

    Returns:
        Binary frame
    """
    method_bytes = frame["method"].encode("utf-8")
    path_bytes = frame["path"].encode("utf-8")
    headers_bytes = encode_headers(frame["headers"])
    flags = FLAG_BODY_FOLLOWS if frame["body_follows"] else 0

    return b"".join(
        [
            struct.pack(">B", FrameType.HTTP_REQUEST_HEAD),
            struct.pack(">I", frame["request_id"]),
            struct.pack(">B", flags),
            struct.pack(">H", len(method_bytes)),
            method_bytes,
            struct.pack(">H", len(path_bytes)),
            path_bytes,
            struct.pack(">I", len(headers_bytes)),
            headers_bytes,
        ]
    )


def deserialize_request_head(data: bytes) -> HTTPRequestHeadFrame:
    """Deserialize an HTTP_REQUEST_HEAD frame.

    Args:
        data: Binary frame

    Returns:
        Request head frame

    Raises:
        TunnelProtocolError: If the frame is malformed or a length exceeds a cap
    """
    _check_type(data, FrameType.HTTP_REQUEST_HEAD)
    request_id = _read_request_id(data)

    _require(data, 5, 1, "flags")
    flags = data[5]
    offset = 6

    _require(data, offset, 2, "method_len")
    (method_len,) = struct.unpack(">H", data[offset : offset + 2])
    offset += 2
    _require(data, offset, method_len, "method")
    try:
        method = data[offset : offset + method_len].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise _malformed("method is not valid UTF-8") from exc
    offset += method_len

    _require(data, offset, 2, "path_len")
    (path_len,) = struct.unpack(">H", data[offset : offset + 2])
    offset += 2
    if path_len > MAX_URL_BYTES:
        raise _malformed(f"Path too large: {path_len} > {MAX_URL_BYTES}")
    _require(data, offset, path_len, "path")
    try:
        path = data[offset : offset + path_len].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise _malformed("path is not valid UTF-8") from exc
    offset += path_len

    headers, _ = _read_headers(data, offset)

    return {
        "request_id": request_id,
        "method": method,
        "path": path,
        "headers": headers,
        "body_follows": bool(flags & FLAG_BODY_FOLLOWS),
    }


# ---------------------------------------------------------------------------
# HTTP_RESPONSE_HEAD
# ---------------------------------------------------------------------------


def serialize_response_head(frame: HTTPResponseHeadFrame) -> bytes:
    """Serialize an HTTP_RESPONSE_HEAD frame.

    Args:
        frame: Response head to serialize

    Returns:
        Binary frame
    """
    headers_bytes = encode_headers(frame["headers"])
    flags = FLAG_BODY_FOLLOWS if frame["body_follows"] else 0

    return b"".join(
        [
            struct.pack(">B", FrameType.HTTP_RESPONSE_HEAD),
            struct.pack(">I", frame["request_id"]),
            struct.pack(">H", frame["status_code"]),
            struct.pack(">B", flags),
            struct.pack(">I", len(headers_bytes)),
            headers_bytes,
        ]
    )


def deserialize_response_head(data: bytes) -> HTTPResponseHeadFrame:
    """Deserialize an HTTP_RESPONSE_HEAD frame.

    Args:
        data: Binary frame

    Returns:
        Response head frame

    Raises:
        TunnelProtocolError: If the frame is malformed or a length exceeds a cap
    """
    _check_type(data, FrameType.HTTP_RESPONSE_HEAD)
    request_id = _read_request_id(data)

    _require(data, 5, 3, "status_code")
    (status_code,) = struct.unpack(">H", data[5:7])
    flags = data[7]

    headers, _ = _read_headers(data, 8)

    return {
        "request_id": request_id,
        "status_code": int(status_code),
        "headers": headers,
        "body_follows": bool(flags & FLAG_BODY_FOLLOWS),
    }


# ---------------------------------------------------------------------------
# HTTP_REQUEST_CHUNK / HTTP_RESPONSE_CHUNK
# ---------------------------------------------------------------------------


def _serialize_chunk(
    frame_type: FrameType, request_id: int, payload: bytes, *, final: bool
) -> bytes:
    """Serialize a chunk frame.

    Args:
        frame_type: HTTP_REQUEST_CHUNK or HTTP_RESPONSE_CHUNK
        request_id: Exchange this chunk belongs to
        payload: Raw body bytes
        final: Whether this is the last chunk

    Returns:
        Binary frame
    """
    return b"".join(
        [
            struct.pack(">B", frame_type),
            struct.pack(">I", request_id),
            struct.pack(">B", FLAG_FINAL if final else 0),
            struct.pack(">I", len(payload)),
            payload,
        ]
    )


def serialize_request_chunk(request_id: int, payload: bytes, *, final: bool) -> bytes:
    """Serialize an HTTP_REQUEST_CHUNK frame.

    Args:
        request_id: Exchange this chunk belongs to
        payload: Raw body bytes
        final: Whether this is the last chunk

    Returns:
        Binary frame
    """
    return _serialize_chunk(FrameType.HTTP_REQUEST_CHUNK, request_id, payload, final=final)


def serialize_response_chunk(request_id: int, payload: bytes, *, final: bool) -> bytes:
    """Serialize an HTTP_RESPONSE_CHUNK frame.

    Args:
        request_id: Exchange this chunk belongs to
        payload: Raw body bytes
        final: Whether this is the last chunk

    Returns:
        Binary frame
    """
    return _serialize_chunk(FrameType.HTTP_RESPONSE_CHUNK, request_id, payload, final=final)


def deserialize_chunk(data: bytes, max_chunk_bytes: int = MAX_CHUNK_BYTES) -> HTTPChunkFrame:
    """Deserialize a request or response chunk frame.

    This is layer 2 of the three that bound a body (spec section 5.5.1): it caps
    a single frame. It cannot bound a multi-frame total, because it is stateless
    and sees one frame at a time - that is the proxy handler's accumulator.

    Args:
        data: Binary frame
        max_chunk_bytes: Effective per-frame cap for this channel

    Returns:
        Chunk frame

    Raises:
        TunnelProtocolError: If the frame is malformed or the payload is oversized
    """
    _require(data, 0, 1, "frame_type")
    frame_type = data[0]
    if frame_type == FrameType.HTTP_RESPONSE_V2_RESERVED:
        raise TunnelProtocolError(
            TunnelErrorCode.E_PROTO_V2_FRAME,
            "Received a v2 HTTP_RESPONSE frame (0x02); peer speaks protocol v2",
        )
    if frame_type not in (FrameType.HTTP_REQUEST_CHUNK, FrameType.HTTP_RESPONSE_CHUNK):
        raise _malformed(f"Expected a chunk frame (0x04 or 0x06), got 0x{frame_type:02x}")

    request_id = _read_request_id(data)

    _require(data, 5, 5, "chunk header")
    flags = data[5]
    (payload_len,) = struct.unpack(">I", data[6:10])

    # Before the slice: a peer may declare 4 GiB in this uint32.
    if payload_len > max_chunk_bytes:
        raise TunnelProtocolError(
            TunnelErrorCode.E_TOO_LARGE,
            f"Chunk too large: {payload_len} > {max_chunk_bytes}",
        )

    _require(data, 10, payload_len, "payload")

    return {
        "frame_type": int(frame_type),
        "request_id": request_id,
        "payload": data[10 : 10 + payload_len],
        "final": bool(flags & FLAG_FINAL),
    }


# ---------------------------------------------------------------------------
# HTTP_CANCEL
# ---------------------------------------------------------------------------


def serialize_cancel(request_id: int, reason_code: int) -> bytes:
    """Serialize an HTTP_CANCEL frame.

    Args:
        request_id: Exchange being abandoned
        reason_code: Code from :class:`~app.tunnel.errors.TunnelErrorCode`

    Returns:
        Binary frame
    """
    return b"".join(
        [
            struct.pack(">B", FrameType.HTTP_CANCEL),
            struct.pack(">I", request_id),
            struct.pack(">H", reason_code),
        ]
    )


def deserialize_cancel(data: bytes) -> HTTPCancelFrame:
    """Deserialize an HTTP_CANCEL frame.

    Args:
        data: Binary frame

    Returns:
        Cancel frame

    Raises:
        TunnelProtocolError: If the frame is malformed
    """
    _check_type(data, FrameType.HTTP_CANCEL)
    request_id = _read_request_id(data)

    _require(data, 5, 2, "reason_code")
    (reason_code,) = struct.unpack(">H", data[5:7])

    return {"request_id": request_id, "reason_code": int(reason_code)}
