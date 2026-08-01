// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025 Lem
//
// This file is part of Lem.
//
// Lem is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Lem is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General
// Public License for more details.

/**
 * WebSocket-over-DataChannel frame serialization for tunnel protocol v3.
 *
 * Mirror of `server/app/tunnel/ws_frame.py`; `protocol/tunnel-v3.json` pins the
 * two together.
 *
 *   WS_CONNECT       0x10  type(1) connection_id(4) url_len(2) url
 *                          headers_len(4) headers (JSON array of pairs)
 *   WS_DATA          0x11  type(1) connection_id(4) opcode(1) flags(1)
 *                          payload_len(4) payload
 *   WS_CLOSE         0x12  type(1) connection_id(4) close_code(2)
 *                          reason_len(2) reason
 *   WS_CONNECT_ACK   0x13  type(1) connection_id(4) protocol_len(2) protocol
 *   WS_CONNECT_ERROR 0x14  type(1) connection_id(4) error_code(2)
 *                          reason_len(2) reason
 */

import {
  FrameType,
  MAX_CHUNK_BYTES,
  MAX_HEADERS_BYTES,
  MAX_URL_BYTES,
  decodeHeaders,
  encodeHeaders,
  type HeaderList,
} from './http-frame'
import { LemProxyError } from './tunnel-errors'

/** Total bytes accepted across the fragments of one WebSocket message. */
export const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024

/** WS_DATA flag bits. */
export const FLAG_FIN = 0x01

/**
 * WebSocket opcode constants (from RFC 6455).
 */
export const WSOpcode = {
  CONTINUATION: 0x00,
  TEXT: 0x01,
  BINARY: 0x02,
  CLOSE: 0x08,
  PING: 0x09,
  PONG: 0x0a,
} as const

export type WSOpcodeValue = (typeof WSOpcode)[keyof typeof WSOpcode]

export interface WSConnectFrame {
  connectionId: number
  url: string
  headers: HeaderList
}

export interface WSDataFrame {
  connectionId: number
  opcode: WSOpcodeValue
  payload: Uint8Array
  fin: boolean
}

export interface WSCloseFrame {
  connectionId: number
  closeCode: number
  reason: string
}

export interface WSConnectAckFrame {
  connectionId: number
  protocol: string
}

export interface WSConnectErrorFrame {
  connectionId: number
  errorCode: number
  reason: string
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

function malformed(message: string): LemProxyError {
  return new LemProxyError('E_PROTO_MALFORMED', message)
}

function asBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function requireLength(bytes: Uint8Array, offset: number, size: number, field: string): void {
  if (bytes.byteLength < offset + size) {
    throw malformed(`Insufficient data for ${field}`)
  }
}

function concat(parts: Uint8Array[]): ArrayBuffer {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out.buffer
}

function u8(value: number): Uint8Array {
  return new Uint8Array([value & 0xff])
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2)
  new DataView(bytes.buffer).setUint16(0, value, false)
  return bytes
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, false)
  return bytes
}

function decodeText(bytes: Uint8Array, field: string): string {
  try {
    return textDecoder.decode(bytes)
  } catch {
    throw malformed(`${field} is not valid UTF-8`)
  }
}

function readHeader(bytes: Uint8Array, expected: number): number {
  requireLength(bytes, 0, 1, 'frame_type')
  if (bytes[0] !== expected) {
    throw malformed(
      `Expected frame 0x${expected.toString(16).padStart(2, '0')}, got 0x${bytes[0].toString(16).padStart(2, '0')}`
    )
  }
  requireLength(bytes, 1, 4, 'connection_id')
  const connectionId = viewOf(bytes).getUint32(1, false)
  if (connectionId === 0) {
    throw malformed('connection_id 0 is reserved')
  }
  return connectionId
}

export function serializeWSConnect(frame: WSConnectFrame): ArrayBuffer {
  const urlBytes = textEncoder.encode(frame.url)
  const headersBytes = encodeHeaders(frame.headers)

  return concat([
    u8(FrameType.WS_CONNECT),
    u32(frame.connectionId),
    u16(urlBytes.byteLength),
    urlBytes,
    u32(headersBytes.byteLength),
    headersBytes,
  ])
}

export function deserializeWSConnect(data: ArrayBuffer | Uint8Array): WSConnectFrame {
  const bytes = asBytes(data)
  const connectionId = readHeader(bytes, FrameType.WS_CONNECT)
  const view = viewOf(bytes)

  requireLength(bytes, 5, 2, 'url_len')
  const urlLen = view.getUint16(5, false)
  if (urlLen > MAX_URL_BYTES) {
    throw malformed(`URL too large: ${urlLen} > ${MAX_URL_BYTES}`)
  }
  requireLength(bytes, 7, urlLen, 'url')
  const url = decodeText(bytes.subarray(7, 7 + urlLen), 'url')
  let offset = 7 + urlLen

  requireLength(bytes, offset, 4, 'headers_len')
  const headersLen = view.getUint32(offset, false)
  offset += 4
  if (headersLen > MAX_HEADERS_BYTES) {
    throw malformed(`Headers too large: ${headersLen} > ${MAX_HEADERS_BYTES}`)
  }
  requireLength(bytes, offset, headersLen, 'headers')
  const headers = decodeHeaders(bytes.subarray(offset, offset + headersLen))

  return { connectionId, url, headers }
}

export function serializeWSData(frame: WSDataFrame): ArrayBuffer {
  return concat([
    u8(FrameType.WS_DATA),
    u32(frame.connectionId),
    u8(frame.opcode),
    u8(frame.fin ? FLAG_FIN : 0),
    u32(frame.payload.byteLength),
    frame.payload,
  ])
}

export function deserializeWSData(
  data: ArrayBuffer | Uint8Array,
  maxChunkBytes: number = MAX_CHUNK_BYTES
): WSDataFrame {
  const bytes = asBytes(data)
  const connectionId = readHeader(bytes, FrameType.WS_DATA)

  requireLength(bytes, 5, 6, 'data header')
  const view = viewOf(bytes)
  const opcode = view.getUint8(5) as WSOpcodeValue
  const flags = view.getUint8(6)
  const payloadLen = view.getUint32(7, false)

  // Before the slice: the length is peer-chosen and uint32-wide.
  if (payloadLen > maxChunkBytes) {
    throw new LemProxyError(
      'E_TOO_LARGE',
      `WebSocket payload too large: ${payloadLen} > ${maxChunkBytes}`
    )
  }

  requireLength(bytes, 11, payloadLen, 'payload')

  return {
    connectionId,
    opcode,
    payload: bytes.slice(11, 11 + payloadLen),
    fin: (flags & FLAG_FIN) !== 0,
  }
}

export function serializeWSClose(frame: WSCloseFrame): ArrayBuffer {
  const reasonBytes = textEncoder.encode(frame.reason)
  return concat([
    u8(FrameType.WS_CLOSE),
    u32(frame.connectionId),
    u16(frame.closeCode),
    u16(reasonBytes.byteLength),
    reasonBytes,
  ])
}

export function deserializeWSClose(data: ArrayBuffer | Uint8Array): WSCloseFrame {
  const bytes = asBytes(data)
  const connectionId = readHeader(bytes, FrameType.WS_CLOSE)

  requireLength(bytes, 5, 4, 'close header')
  const view = viewOf(bytes)
  const closeCode = view.getUint16(5, false)
  const reasonLen = view.getUint16(7, false)
  requireLength(bytes, 9, reasonLen, 'reason')
  const reason = decodeText(bytes.subarray(9, 9 + reasonLen), 'reason')

  return { connectionId, closeCode, reason }
}

export function serializeWSConnectAck(frame: WSConnectAckFrame): ArrayBuffer {
  const protocolBytes = textEncoder.encode(frame.protocol)
  return concat([
    u8(FrameType.WS_CONNECT_ACK),
    u32(frame.connectionId),
    u16(protocolBytes.byteLength),
    protocolBytes,
  ])
}

export function deserializeWSConnectAck(data: ArrayBuffer | Uint8Array): WSConnectAckFrame {
  const bytes = asBytes(data)
  const connectionId = readHeader(bytes, FrameType.WS_CONNECT_ACK)

  requireLength(bytes, 5, 2, 'protocol_len')
  const protocolLen = viewOf(bytes).getUint16(5, false)
  requireLength(bytes, 7, protocolLen, 'protocol')
  const protocol = decodeText(bytes.subarray(7, 7 + protocolLen), 'protocol')

  return { connectionId, protocol }
}

export function serializeWSConnectError(frame: WSConnectErrorFrame): ArrayBuffer {
  const reasonBytes = textEncoder.encode(frame.reason)
  return concat([
    u8(FrameType.WS_CONNECT_ERROR),
    u32(frame.connectionId),
    u16(frame.errorCode),
    u16(reasonBytes.byteLength),
    reasonBytes,
  ])
}

export function deserializeWSConnectError(data: ArrayBuffer | Uint8Array): WSConnectErrorFrame {
  const bytes = asBytes(data)
  const connectionId = readHeader(bytes, FrameType.WS_CONNECT_ERROR)

  requireLength(bytes, 5, 4, 'error header')
  const view = viewOf(bytes)
  const errorCode = view.getUint16(5, false)
  const reasonLen = view.getUint16(7, false)
  requireLength(bytes, 9, reasonLen, 'reason')
  const reason = decodeText(bytes.subarray(9, 9 + reasonLen), 'reason')

  return { connectionId, errorCode, reason }
}
