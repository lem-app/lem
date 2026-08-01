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

"""WebSocket-over-DataChannel frame serialization for tunnel protocol v3.

Two changes from v2 (spec sections 5.3 and 5.4):

* **The handshake is acknowledged.** v2 opened the upstream socket and told the
  browser nothing, so ``ProxiedWebSocket`` sat in CONNECTING forever, ``onopen``
  never fired, and every ``send()`` threw. ``WS_CONNECT_ACK`` (0x13) and
  ``WS_CONNECT_ERROR`` (0x14) close that hole.
* **WS_DATA carries a FIN flag**, so a message larger than the negotiated chunk
  size can be fragmented and reassembled.

Layouts, all integers big-endian, connection_id always at bytes 1..4::

    WS_CONNECT       0x10  type(1) connection_id(4) url_len(2) url
                           headers_len(4) headers (JSON array of pairs)
    WS_DATA          0x11  type(1) connection_id(4) opcode(1) flags(1)
                           payload_len(4) payload
    WS_CLOSE         0x12  type(1) connection_id(4) close_code(2)
                           reason_len(2) reason
    WS_CONNECT_ACK   0x13  type(1) connection_id(4) protocol_len(2) protocol
    WS_CONNECT_ERROR 0x14  type(1) connection_id(4) error_code(2)
                           reason_len(2) reason
"""

import struct
from enum import IntEnum
from typing import TypedDict

from .errors import TunnelErrorCode, TunnelProtocolError
from .http_frame import (
    MAX_CHUNK_BYTES,
    MAX_HEADERS_BYTES,
    MAX_URL_BYTES,
    FrameType,
    HeaderList,
    decode_headers,
    encode_headers,
)

# Total bytes accepted across the fragments of one WebSocket message.
MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024  # 8 MiB

# WS_DATA flag bits.
FLAG_FIN = 0x01


class WSOpcode(IntEnum):
    """WebSocket opcode constants (from RFC 6455)."""

    CONTINUATION = 0x00
    TEXT = 0x01
    BINARY = 0x02
    CLOSE = 0x08
    PING = 0x09
    PONG = 0x0A


class WSConnectFrame(TypedDict):
    """WebSocket CONNECT frame."""

    connection_id: int
    url: str
    headers: HeaderList


class WSDataFrame(TypedDict):
    """WebSocket DATA frame."""

    connection_id: int
    opcode: int
    payload: bytes
    fin: bool


class WSCloseFrame(TypedDict):
    """WebSocket CLOSE frame."""

    connection_id: int
    close_code: int
    reason: str


class WSConnectAckFrame(TypedDict):
    """Acknowledgement that the upstream socket is open."""

    connection_id: int
    protocol: str


class WSConnectErrorFrame(TypedDict):
    """Refusal of a WebSocket handshake."""

    connection_id: int
    error_code: int
    reason: str


def _malformed(message: str) -> TunnelProtocolError:
    """Build a malformed-frame error.

    Args:
        message: Local-only detail

    Returns:
        Error carrying E_PROTO_MALFORMED
    """
    return TunnelProtocolError(TunnelErrorCode.E_PROTO_MALFORMED, message)


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


def _read_header(data: bytes, expected: FrameType) -> int:
    """Validate the frame type and read the connection_id.

    Args:
        data: Raw frame bytes
        expected: Frame type the caller is decoding

    Returns:
        The connection_id

    Raises:
        TunnelProtocolError: If the type is wrong or the id is 0
    """
    _require(data, 0, 1, "frame_type")
    if data[0] != expected:
        raise _malformed(f"Expected frame 0x{expected:02x}, got 0x{data[0]:02x}")

    _require(data, 1, 4, "connection_id")
    (connection_id,) = struct.unpack(">I", data[1:5])
    if connection_id == 0:
        raise _malformed("connection_id 0 is reserved")
    return int(connection_id)


def _read_text(data: bytes, offset: int, length: int, field: str) -> str:
    """Read a UTF-8 field.

    Args:
        data: Raw frame bytes
        offset: Read position
        length: Byte length
        field: Field name for the error message

    Returns:
        Decoded string

    Raises:
        TunnelProtocolError: If the frame is truncated or the bytes are not UTF-8
    """
    _require(data, offset, length, field)
    try:
        return data[offset : offset + length].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise _malformed(f"{field} is not valid UTF-8") from exc


def serialize_ws_connect(frame: WSConnectFrame) -> bytes:
    """Serialize a WS_CONNECT frame.

    Args:
        frame: CONNECT frame to serialize

    Returns:
        Binary frame
    """
    url_bytes = frame["url"].encode("utf-8")
    headers_bytes = encode_headers(frame["headers"])

    return b"".join(
        [
            struct.pack(">B", FrameType.WS_CONNECT),
            struct.pack(">I", frame["connection_id"]),
            struct.pack(">H", len(url_bytes)),
            url_bytes,
            struct.pack(">I", len(headers_bytes)),
            headers_bytes,
        ]
    )


def deserialize_ws_connect(data: bytes) -> WSConnectFrame:
    """Deserialize a WS_CONNECT frame.

    Args:
        data: Binary frame

    Returns:
        CONNECT frame

    Raises:
        TunnelProtocolError: If the frame is malformed or a length exceeds a cap
    """
    connection_id = _read_header(data, FrameType.WS_CONNECT)

    _require(data, 5, 2, "url_len")
    (url_len,) = struct.unpack(">H", data[5:7])
    if url_len > MAX_URL_BYTES:
        raise _malformed(f"URL too large: {url_len} > {MAX_URL_BYTES}")
    url = _read_text(data, 7, url_len, "url")
    offset = 7 + url_len

    _require(data, offset, 4, "headers_len")
    (headers_len,) = struct.unpack(">I", data[offset : offset + 4])
    offset += 4
    if headers_len > MAX_HEADERS_BYTES:
        raise _malformed(f"Headers too large: {headers_len} > {MAX_HEADERS_BYTES}")
    _require(data, offset, headers_len, "headers")
    headers = decode_headers(data[offset : offset + headers_len])

    return {"connection_id": connection_id, "url": url, "headers": headers}


def serialize_ws_data(frame: WSDataFrame) -> bytes:
    """Serialize a WS_DATA frame.

    Args:
        frame: DATA frame to serialize

    Returns:
        Binary frame
    """
    payload = frame["payload"]
    return b"".join(
        [
            struct.pack(">B", FrameType.WS_DATA),
            struct.pack(">I", frame["connection_id"]),
            struct.pack(">B", frame["opcode"]),
            struct.pack(">B", FLAG_FIN if frame["fin"] else 0),
            struct.pack(">I", len(payload)),
            payload,
        ]
    )


def deserialize_ws_data(data: bytes, max_chunk_bytes: int = MAX_CHUNK_BYTES) -> WSDataFrame:
    """Deserialize a WS_DATA frame.

    Args:
        data: Binary frame
        max_chunk_bytes: Effective per-frame cap for this channel

    Returns:
        DATA frame

    Raises:
        TunnelProtocolError: If the frame is malformed or the payload is oversized
    """
    connection_id = _read_header(data, FrameType.WS_DATA)

    _require(data, 5, 6, "data header")
    opcode = data[5]
    flags = data[6]
    (payload_len,) = struct.unpack(">I", data[7:11])

    # Before the slice: the length is peer-chosen and uint32-wide.
    if payload_len > max_chunk_bytes:
        raise TunnelProtocolError(
            TunnelErrorCode.E_TOO_LARGE,
            f"WebSocket payload too large: {payload_len} > {max_chunk_bytes}",
        )

    _require(data, 11, payload_len, "payload")

    return {
        "connection_id": connection_id,
        "opcode": int(opcode),
        "payload": data[11 : 11 + payload_len],
        "fin": bool(flags & FLAG_FIN),
    }


def serialize_ws_close(frame: WSCloseFrame) -> bytes:
    """Serialize a WS_CLOSE frame.

    Args:
        frame: CLOSE frame to serialize

    Returns:
        Binary frame
    """
    reason_bytes = frame["reason"].encode("utf-8")
    return b"".join(
        [
            struct.pack(">B", FrameType.WS_CLOSE),
            struct.pack(">I", frame["connection_id"]),
            struct.pack(">H", frame["close_code"]),
            struct.pack(">H", len(reason_bytes)),
            reason_bytes,
        ]
    )


def deserialize_ws_close(data: bytes) -> WSCloseFrame:
    """Deserialize a WS_CLOSE frame.

    Args:
        data: Binary frame

    Returns:
        CLOSE frame

    Raises:
        TunnelProtocolError: If the frame is malformed
    """
    connection_id = _read_header(data, FrameType.WS_CLOSE)

    _require(data, 5, 4, "close header")
    (close_code, reason_len) = struct.unpack(">HH", data[5:9])
    reason = _read_text(data, 9, reason_len, "reason")

    return {
        "connection_id": connection_id,
        "close_code": int(close_code),
        "reason": reason,
    }


def serialize_ws_connect_ack(frame: WSConnectAckFrame) -> bytes:
    """Serialize a WS_CONNECT_ACK frame.

    Args:
        frame: ACK frame to serialize

    Returns:
        Binary frame
    """
    protocol_bytes = frame["protocol"].encode("utf-8")
    return b"".join(
        [
            struct.pack(">B", FrameType.WS_CONNECT_ACK),
            struct.pack(">I", frame["connection_id"]),
            struct.pack(">H", len(protocol_bytes)),
            protocol_bytes,
        ]
    )


def deserialize_ws_connect_ack(data: bytes) -> WSConnectAckFrame:
    """Deserialize a WS_CONNECT_ACK frame.

    Args:
        data: Binary frame

    Returns:
        ACK frame

    Raises:
        TunnelProtocolError: If the frame is malformed
    """
    connection_id = _read_header(data, FrameType.WS_CONNECT_ACK)

    _require(data, 5, 2, "protocol_len")
    (protocol_len,) = struct.unpack(">H", data[5:7])
    protocol = _read_text(data, 7, protocol_len, "protocol")

    return {"connection_id": connection_id, "protocol": protocol}


def serialize_ws_connect_error(frame: WSConnectErrorFrame) -> bytes:
    """Serialize a WS_CONNECT_ERROR frame.

    Args:
        frame: ERROR frame to serialize

    Returns:
        Binary frame
    """
    reason_bytes = frame["reason"].encode("utf-8")
    return b"".join(
        [
            struct.pack(">B", FrameType.WS_CONNECT_ERROR),
            struct.pack(">I", frame["connection_id"]),
            struct.pack(">H", frame["error_code"]),
            struct.pack(">H", len(reason_bytes)),
            reason_bytes,
        ]
    )


def deserialize_ws_connect_error(data: bytes) -> WSConnectErrorFrame:
    """Deserialize a WS_CONNECT_ERROR frame.

    Args:
        data: Binary frame

    Returns:
        ERROR frame

    Raises:
        TunnelProtocolError: If the frame is malformed
    """
    connection_id = _read_header(data, FrameType.WS_CONNECT_ERROR)

    _require(data, 5, 4, "error header")
    (error_code, reason_len) = struct.unpack(">HH", data[5:9])
    reason = _read_text(data, 9, reason_len, "reason")

    return {
        "connection_id": connection_id,
        "error_code": int(error_code),
        "reason": reason,
    }
