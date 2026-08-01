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
 * HTTP-over-DataChannel frame serialization for tunnel protocol v3.
 *
 * The byte layouts here are the mirror of `server/app/tunnel/http_frame.py`, and
 * `protocol/tunnel-v3.json` pins the two together with golden vectors that both
 * test suites decode and re-encode. FrameType drifted between these two files
 * once already (v1 to v2) and left the suite red for months.
 *
 * All integers big-endian, byte 0 always the frame type, bytes 1..4 always the
 * request_id for the HTTP family:
 *
 *   HELLO               0x00  type(1) version(1) flags(2) max_chunk(4)
 *                             max_body(4) impl_len(2) impl
 *   HTTP_REQUEST_HEAD   0x01  type(1) request_id(4) flags(1) method_len(2)
 *                             method path_len(2) path headers_len(4) headers
 *   (reserved)          0x02  v2 HTTP_RESPONSE. Receipt is a protocol error.
 *   HTTP_RESPONSE_HEAD  0x03  type(1) request_id(4) status(2) flags(1)
 *                             headers_len(4) headers
 *   HTTP_RESPONSE_CHUNK 0x04  type(1) request_id(4) flags(1) payload_len(4)
 *                             payload
 *   HTTP_CANCEL         0x05  type(1) request_id(4) reason_code(2)
 *   HTTP_REQUEST_CHUNK  0x06  same layout as 0x04
 */

import { LemProxyError } from './tunnel-errors'

/** Wire version advertised in HELLO. */
export const PROTOCOL_VERSION = 3

/**
 * Declared lengths are uint32, so a peer can claim up to 4 GiB. These cap what
 * this peer is willing to accept before allocating anything on its behalf.
 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024
export const MAX_HEADERS_BYTES = 256 * 1024

/**
 * Largest payload accepted in one CHUNK or WS_DATA frame. This is the *default
 * advertised* value, not a protocol constant: each peer advertises its own in
 * HELLO and the effective value is min(local, peer, transport). 48 KiB is
 * derived from SCTP's 64 KiB interoperable floor less frame overhead.
 */
export const MAX_CHUNK_BYTES = 48 * 1024

/** Longest path or WebSocket URL accepted. */
export const MAX_URL_BYTES = 8 * 1024

/** Concurrent request_ids this peer will keep open, per direction. */
export const MAX_INFLIGHT_REQUESTS = 128

/** Flag bits. */
export const FLAG_BODY_FOLLOWS = 0x01
export const FLAG_FINAL = 0x01

/**
 * Frame type constants (spec section 5.3).
 */
export const FrameType = {
  HELLO: 0x00,
  HTTP_REQUEST_HEAD: 0x01,
  /** v2's HTTP_RESPONSE. Reserved, never sent; receipt is E_PROTO_V2_FRAME. */
  HTTP_RESPONSE_V2_RESERVED: 0x02,
  HTTP_RESPONSE_HEAD: 0x03,
  HTTP_RESPONSE_CHUNK: 0x04,
  HTTP_CANCEL: 0x05,
  HTTP_REQUEST_CHUNK: 0x06,
  WS_CONNECT: 0x10,
  WS_DATA: 0x11,
  WS_CLOSE: 0x12,
  WS_CONNECT_ACK: 0x13,
  WS_CONNECT_ERROR: 0x14,
} as const

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType]

/** Headers travel as an ordered array of pairs so duplicates survive. */
export type HeaderList = [string, string][]

export interface HelloFrame {
  protocolVersion: number
  flags: number
  maxChunkBytes: number
  maxBodyBytes: number
  impl: string
}

export interface HTTPRequestHeadFrame {
  requestId: number
  method: string
  path: string
  headers: HeaderList
  bodyFollows: boolean
}

export interface HTTPResponseHeadFrame {
  requestId: number
  statusCode: number
  headers: HeaderList
  bodyFollows: boolean
}

export interface HTTPChunkFrame {
  frameType: number
  requestId: number
  payload: Uint8Array
  final: boolean
}

export interface HTTPCancelFrame {
  requestId: number
  reasonCode: number
}

const textEncoder = new TextEncoder()
// fatal: invalid UTF-8 in a field that must be text is a malformed frame, not
// something to paper over with replacement characters.
const textDecoder = new TextDecoder('utf-8', { fatal: true })

function malformed(message: string): LemProxyError {
  return new LemProxyError('E_PROTO_MALFORMED', message)
}

function requireLength(buffer: Uint8Array, offset: number, size: number, field: string): void {
  if (buffer.byteLength < offset + size) {
    throw malformed(`Insufficient data for ${field}`)
  }
}

/** Normalise any binary input to a byte view without copying. */
function asBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** Concatenate parts into one frame buffer. */
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

/**
 * Read byte 0 without deserializing the rest.
 */
export function peekFrameType(data: ArrayBuffer | Uint8Array): number | null {
  const bytes = asBytes(data)
  return bytes.byteLength < 1 ? null : bytes[0]
}

/**
 * Read the request_id every HTTP-family frame carries at bytes 1..4.
 *
 * Byte 0 is the frame type; reading from offset 0 puts it in the top octet.
 */
export function peekRequestId(data: ArrayBuffer | Uint8Array): number | null {
  const bytes = asBytes(data)
  if (bytes.byteLength < 5) return null
  return viewOf(bytes).getUint32(1, false)
}

/** Encode a header list as the wire's JSON array of pairs. */
export function encodeHeaders(headers: HeaderList): Uint8Array {
  return textEncoder.encode(JSON.stringify(headers))
}

/**
 * Decode and validate the wire's JSON array of header pairs.
 *
 * The peer chooses these bytes, so the shape is checked rather than trusted: a
 * JSON object (v2's encoding), a nested array, or a non-string value are all
 * rejected rather than coerced.
 */
export function decodeHeaders(raw: Uint8Array): HeaderList {
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeText(raw, 'headers')) as unknown
  } catch (error) {
    throw malformed(`Headers are not valid JSON: ${String(error)}`)
  }

  if (!Array.isArray(parsed)) {
    throw malformed('Headers must be a JSON array of [name, value] pairs')
  }

  const headers: HeaderList = []
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw malformed('Each header must be a two-element array')
    }
    const [name, value] = entry as unknown[]
    if (typeof name !== 'string' || typeof value !== 'string') {
      throw malformed('Header names and values must be strings')
    }
    headers.push([name, value])
  }
  return headers
}

function checkType(bytes: Uint8Array, expected: number): void {
  requireLength(bytes, 0, 1, 'frame_type')
  const frameType = bytes[0]
  if (frameType === FrameType.HTTP_RESPONSE_V2_RESERVED) {
    throw new LemProxyError(
      'E_PROTO_V2_FRAME',
      'Received a v2 HTTP_RESPONSE frame (0x02); peer speaks protocol v2'
    )
  }
  if (frameType !== expected) {
    throw malformed(
      `Expected frame 0x${expected.toString(16).padStart(2, '0')}, got 0x${frameType.toString(16).padStart(2, '0')}`
    )
  }
}

function readRequestId(bytes: Uint8Array): number {
  requireLength(bytes, 1, 4, 'request_id')
  const requestId = viewOf(bytes).getUint32(1, false)
  if (requestId === 0) {
    throw malformed('request_id 0 is reserved')
  }
  return requestId
}

function readHeaders(bytes: Uint8Array, offset: number): { headers: HeaderList; offset: number } {
  requireLength(bytes, offset, 4, 'headers_len')
  const headersLen = viewOf(bytes).getUint32(offset, false)
  offset += 4

  // Before the slice, always: the length is peer-chosen and uint32-wide.
  if (headersLen > MAX_HEADERS_BYTES) {
    throw malformed(`Headers too large: ${headersLen} > ${MAX_HEADERS_BYTES}`)
  }

  requireLength(bytes, offset, headersLen, 'headers')
  const headers = decodeHeaders(bytes.subarray(offset, offset + headersLen))
  return { headers, offset: offset + headersLen }
}

// ---------------------------------------------------------------------------
// HELLO
// ---------------------------------------------------------------------------

export function serializeHello(frame: HelloFrame): ArrayBuffer {
  const implBytes = textEncoder.encode(frame.impl)
  return concat([
    u8(FrameType.HELLO),
    u8(frame.protocolVersion),
    u16(frame.flags),
    u32(frame.maxChunkBytes),
    u32(frame.maxBodyBytes),
    u16(implBytes.byteLength),
    implBytes,
  ])
}

export function deserializeHello(data: ArrayBuffer | Uint8Array): HelloFrame {
  const bytes = asBytes(data)
  checkType(bytes, FrameType.HELLO)
  requireLength(bytes, 1, 13, 'hello header')

  const view = viewOf(bytes)
  const protocolVersion = view.getUint8(1)
  const flags = view.getUint16(2, false)
  const maxChunkBytes = view.getUint32(4, false)
  const maxBodyBytes = view.getUint32(8, false)
  const implLen = view.getUint16(12, false)

  requireLength(bytes, 14, implLen, 'impl')
  const impl = decodeText(bytes.subarray(14, 14 + implLen), 'impl')

  return { protocolVersion, flags, maxChunkBytes, maxBodyBytes, impl }
}

// ---------------------------------------------------------------------------
// HTTP_REQUEST_HEAD
// ---------------------------------------------------------------------------

export function serializeRequestHead(frame: HTTPRequestHeadFrame): ArrayBuffer {
  const methodBytes = textEncoder.encode(frame.method)
  const pathBytes = textEncoder.encode(frame.path)
  const headersBytes = encodeHeaders(frame.headers)

  return concat([
    u8(FrameType.HTTP_REQUEST_HEAD),
    u32(frame.requestId),
    u8(frame.bodyFollows ? FLAG_BODY_FOLLOWS : 0),
    u16(methodBytes.byteLength),
    methodBytes,
    u16(pathBytes.byteLength),
    pathBytes,
    u32(headersBytes.byteLength),
    headersBytes,
  ])
}

export function deserializeRequestHead(data: ArrayBuffer | Uint8Array): HTTPRequestHeadFrame {
  const bytes = asBytes(data)
  checkType(bytes, FrameType.HTTP_REQUEST_HEAD)
  const requestId = readRequestId(bytes)
  const view = viewOf(bytes)

  requireLength(bytes, 5, 1, 'flags')
  const flags = view.getUint8(5)
  let offset = 6

  requireLength(bytes, offset, 2, 'method_len')
  const methodLen = view.getUint16(offset, false)
  offset += 2
  requireLength(bytes, offset, methodLen, 'method')
  const method = decodeText(bytes.subarray(offset, offset + methodLen), 'method')
  offset += methodLen

  requireLength(bytes, offset, 2, 'path_len')
  const pathLen = view.getUint16(offset, false)
  offset += 2
  if (pathLen > MAX_URL_BYTES) {
    throw malformed(`Path too large: ${pathLen} > ${MAX_URL_BYTES}`)
  }
  requireLength(bytes, offset, pathLen, 'path')
  const path = decodeText(bytes.subarray(offset, offset + pathLen), 'path')
  offset += pathLen

  const { headers } = readHeaders(bytes, offset)

  return {
    requestId,
    method,
    path,
    headers,
    bodyFollows: (flags & FLAG_BODY_FOLLOWS) !== 0,
  }
}

// ---------------------------------------------------------------------------
// HTTP_RESPONSE_HEAD
// ---------------------------------------------------------------------------

export function serializeResponseHead(frame: HTTPResponseHeadFrame): ArrayBuffer {
  const headersBytes = encodeHeaders(frame.headers)
  return concat([
    u8(FrameType.HTTP_RESPONSE_HEAD),
    u32(frame.requestId),
    u16(frame.statusCode),
    u8(frame.bodyFollows ? FLAG_BODY_FOLLOWS : 0),
    u32(headersBytes.byteLength),
    headersBytes,
  ])
}

export function deserializeResponseHead(data: ArrayBuffer | Uint8Array): HTTPResponseHeadFrame {
  const bytes = asBytes(data)
  checkType(bytes, FrameType.HTTP_RESPONSE_HEAD)
  const requestId = readRequestId(bytes)

  requireLength(bytes, 5, 3, 'status_code')
  const view = viewOf(bytes)
  const statusCode = view.getUint16(5, false)
  const flags = view.getUint8(7)

  const { headers } = readHeaders(bytes, 8)

  return {
    requestId,
    statusCode,
    headers,
    bodyFollows: (flags & FLAG_BODY_FOLLOWS) !== 0,
  }
}

// ---------------------------------------------------------------------------
// HTTP_REQUEST_CHUNK / HTTP_RESPONSE_CHUNK
// ---------------------------------------------------------------------------

function serializeChunk(
  frameType: number,
  requestId: number,
  payload: Uint8Array,
  final: boolean
): ArrayBuffer {
  return concat([
    u8(frameType),
    u32(requestId),
    u8(final ? FLAG_FINAL : 0),
    u32(payload.byteLength),
    payload,
  ])
}

export function serializeRequestChunk(
  requestId: number,
  payload: Uint8Array,
  final: boolean
): ArrayBuffer {
  return serializeChunk(FrameType.HTTP_REQUEST_CHUNK, requestId, payload, final)
}

export function serializeResponseChunk(
  requestId: number,
  payload: Uint8Array,
  final: boolean
): ArrayBuffer {
  return serializeChunk(FrameType.HTTP_RESPONSE_CHUNK, requestId, payload, final)
}

/**
 * Deserialize a request or response chunk frame.
 *
 * This caps a single frame. It cannot bound a multi-frame total, because it is
 * stateless and sees one frame at a time - that is the proxy's accumulator
 * (spec section 5.5.1).
 */
export function deserializeChunk(
  data: ArrayBuffer | Uint8Array,
  maxChunkBytes: number = MAX_CHUNK_BYTES
): HTTPChunkFrame {
  const bytes = asBytes(data)
  requireLength(bytes, 0, 1, 'frame_type')
  const frameType = bytes[0]

  if (frameType === FrameType.HTTP_RESPONSE_V2_RESERVED) {
    throw new LemProxyError(
      'E_PROTO_V2_FRAME',
      'Received a v2 HTTP_RESPONSE frame (0x02); peer speaks protocol v2'
    )
  }
  if (frameType !== FrameType.HTTP_REQUEST_CHUNK && frameType !== FrameType.HTTP_RESPONSE_CHUNK) {
    throw malformed(
      `Expected a chunk frame (0x04 or 0x06), got 0x${frameType.toString(16).padStart(2, '0')}`
    )
  }

  const requestId = readRequestId(bytes)
  requireLength(bytes, 5, 5, 'chunk header')

  const view = viewOf(bytes)
  const flags = view.getUint8(5)
  const payloadLen = view.getUint32(6, false)

  // Before the slice: a peer may declare 4 GiB in this uint32.
  if (payloadLen > maxChunkBytes) {
    throw new LemProxyError('E_TOO_LARGE', `Chunk too large: ${payloadLen} > ${maxChunkBytes}`)
  }

  requireLength(bytes, 10, payloadLen, 'payload')

  return {
    frameType,
    requestId,
    // Copy: the caller keeps this past the lifetime of the receive buffer.
    payload: bytes.slice(10, 10 + payloadLen),
    final: (flags & FLAG_FINAL) !== 0,
  }
}

// ---------------------------------------------------------------------------
// HTTP_CANCEL
// ---------------------------------------------------------------------------

export function serializeCancel(requestId: number, reasonCode: number): ArrayBuffer {
  return concat([u8(FrameType.HTTP_CANCEL), u32(requestId), u16(reasonCode)])
}

export function deserializeCancel(data: ArrayBuffer | Uint8Array): HTTPCancelFrame {
  const bytes = asBytes(data)
  checkType(bytes, FrameType.HTTP_CANCEL)
  const requestId = readRequestId(bytes)

  requireLength(bytes, 5, 2, 'reason_code')
  const reasonCode = viewOf(bytes).getUint16(5, false)

  return { requestId, reasonCode }
}
