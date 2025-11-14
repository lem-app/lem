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
 * WebSocket-over-DataChannel frame serialization/deserialization.
 *
 * Binary frame format for WebSocket CONNECT:
 * - 1 byte: frame_type (0x10)
 * - 4 bytes: connection_id (uint32)
 * - 2 bytes: url_len (uint16)
 * - url_len bytes: WebSocket URL (UTF-8)
 * - 4 bytes: headers_len (uint32)
 * - headers_len bytes: JSON headers
 *
 * Binary frame format for WebSocket DATA:
 * - 1 byte: frame_type (0x11)
 * - 4 bytes: connection_id (uint32)
 * - 1 byte: opcode (0=continuation, 1=text, 2=binary, 8=close, 9=ping, 10=pong)
 * - 4 bytes: payload_len (uint32)
 * - payload_len bytes: WebSocket payload (raw bytes)
 *
 * Binary frame format for WebSocket CLOSE:
 * - 1 byte: frame_type (0x12)
 * - 4 bytes: connection_id (uint32)
 * - 2 bytes: close_code (uint16)
 * - 2 bytes: reason_len (uint16)
 * - reason_len bytes: close reason (UTF-8)
 */

import { FrameType } from './http-frame'

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

/**
 * WebSocket CONNECT frame.
 */
export interface WSConnectFrame {
  connectionId: number
  url: string
  headers: Record<string, string>
}

/**
 * WebSocket DATA frame.
 */
export interface WSDataFrame {
  connectionId: number
  opcode: WSOpcodeValue
  payload: ArrayBuffer
}

/**
 * WebSocket CLOSE frame.
 */
export interface WSCloseFrame {
  connectionId: number
  closeCode: number
  reason: string
}

/**
 * Text encoder/decoder for UTF-8 conversion.
 */
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * Serialize WebSocket CONNECT frame to binary.
 */
export function serializeWSConnect(frame: WSConnectFrame): ArrayBuffer {
  // Encode strings to UTF-8
  const urlBytes = textEncoder.encode(frame.url)
  const headersBytes = textEncoder.encode(JSON.stringify(frame.headers))

  // Calculate total size
  const totalSize =
    1 + // frame_type
    4 + // connection_id
    2 +
    urlBytes.length + // url_len + url
    4 +
    headersBytes.length // headers_len + headers

  // Create buffer
  const buffer = new ArrayBuffer(totalSize)
  const view = new DataView(buffer)
  let offset = 0

  // Write frame_type (uint8)
  view.setUint8(offset, FrameType.WS_CONNECT)
  offset += 1

  // Write connection_id (uint32)
  view.setUint32(offset, frame.connectionId, false) // big-endian
  offset += 4

  // Write url_len (uint16) and url
  view.setUint16(offset, urlBytes.length, false)
  offset += 2
  new Uint8Array(buffer, offset, urlBytes.length).set(urlBytes)
  offset += urlBytes.length

  // Write headers_len (uint32) and headers
  view.setUint32(offset, headersBytes.length, false)
  offset += 4
  new Uint8Array(buffer, offset, headersBytes.length).set(headersBytes)

  return buffer
}

/**
 * Deserialize binary frame to WebSocket CONNECT.
 */
export function deserializeWSConnect(buffer: ArrayBuffer): WSConnectFrame {
  const view = new DataView(buffer)
  let offset = 0

  // Read frame_type (uint8) and validate
  const frameType = view.getUint8(offset)
  offset += 1

  if (frameType !== FrameType.WS_CONNECT) {
    throw new Error(`Expected WS_CONNECT frame (0x10), got 0x${frameType.toString(16)}`)
  }

  // Read connection_id (uint32)
  const connectionId = view.getUint32(offset, false)
  offset += 4

  // Read url_len (uint16) and url
  const urlLen = view.getUint16(offset, false)
  offset += 2
  const urlBytes = new Uint8Array(buffer, offset, urlLen)
  const url = textDecoder.decode(urlBytes)
  offset += urlLen

  // Read headers_len (uint32) and headers
  const headersLen = view.getUint32(offset, false)
  offset += 4
  const headersBytes = new Uint8Array(buffer, offset, headersLen)
  const headersJson = textDecoder.decode(headersBytes)
  const headers = JSON.parse(headersJson) as Record<string, string>

  return {
    connectionId,
    url,
    headers,
  }
}

/**
 * Serialize WebSocket DATA frame to binary.
 */
export function serializeWSData(frame: WSDataFrame): ArrayBuffer {
  const payloadBytes = new Uint8Array(frame.payload)

  // Calculate total size
  const totalSize =
    1 + // frame_type
    4 + // connection_id
    1 + // opcode
    4 + // payload_len
    payloadBytes.length // payload

  // Create buffer
  const buffer = new ArrayBuffer(totalSize)
  const view = new DataView(buffer)
  let offset = 0

  // Write frame_type (uint8)
  view.setUint8(offset, FrameType.WS_DATA)
  offset += 1

  // Write connection_id (uint32)
  view.setUint32(offset, frame.connectionId, false)
  offset += 4

  // Write opcode (uint8)
  view.setUint8(offset, frame.opcode)
  offset += 1

  // Write payload_len (uint32) and payload
  view.setUint32(offset, payloadBytes.length, false)
  offset += 4
  new Uint8Array(buffer, offset, payloadBytes.length).set(payloadBytes)

  return buffer
}

/**
 * Deserialize binary frame to WebSocket DATA.
 */
export function deserializeWSData(buffer: ArrayBuffer): WSDataFrame {
  const view = new DataView(buffer)
  let offset = 0

  // Read frame_type (uint8) and validate
  const frameType = view.getUint8(offset)
  offset += 1

  if (frameType !== FrameType.WS_DATA) {
    throw new Error(`Expected WS_DATA frame (0x11), got 0x${frameType.toString(16)}`)
  }

  // Read connection_id (uint32)
  const connectionId = view.getUint32(offset, false)
  offset += 4

  // Read opcode (uint8)
  const opcode = view.getUint8(offset) as WSOpcodeValue
  offset += 1

  // Read payload_len (uint32) and payload
  const payloadLen = view.getUint32(offset, false)
  offset += 4
  const payload = buffer.slice(offset, offset + payloadLen)

  return {
    connectionId,
    opcode,
    payload,
  }
}

/**
 * Serialize WebSocket CLOSE frame to binary.
 */
export function serializeWSClose(frame: WSCloseFrame): ArrayBuffer {
  // Encode reason to UTF-8
  const reasonBytes = textEncoder.encode(frame.reason)

  // Calculate total size
  const totalSize =
    1 + // frame_type
    4 + // connection_id
    2 + // close_code
    2 +
    reasonBytes.length // reason_len + reason

  // Create buffer
  const buffer = new ArrayBuffer(totalSize)
  const view = new DataView(buffer)
  let offset = 0

  // Write frame_type (uint8)
  view.setUint8(offset, FrameType.WS_CLOSE)
  offset += 1

  // Write connection_id (uint32)
  view.setUint32(offset, frame.connectionId, false)
  offset += 4

  // Write close_code (uint16)
  view.setUint16(offset, frame.closeCode, false)
  offset += 2

  // Write reason_len (uint16) and reason
  view.setUint16(offset, reasonBytes.length, false)
  offset += 2
  new Uint8Array(buffer, offset, reasonBytes.length).set(reasonBytes)

  return buffer
}

/**
 * Deserialize binary frame to WebSocket CLOSE.
 */
export function deserializeWSClose(buffer: ArrayBuffer): WSCloseFrame {
  const view = new DataView(buffer)
  let offset = 0

  // Read frame_type (uint8) and validate
  const frameType = view.getUint8(offset)
  offset += 1

  if (frameType !== FrameType.WS_CLOSE) {
    throw new Error(`Expected WS_CLOSE frame (0x12), got 0x${frameType.toString(16)}`)
  }

  // Read connection_id (uint32)
  const connectionId = view.getUint32(offset, false)
  offset += 4

  // Read close_code (uint16)
  const closeCode = view.getUint16(offset, false)
  offset += 2

  // Read reason_len (uint16) and reason
  const reasonLen = view.getUint16(offset, false)
  offset += 2
  const reasonBytes = new Uint8Array(buffer, offset, reasonLen)
  const reason = textDecoder.decode(reasonBytes)

  return {
    connectionId,
    closeCode,
    reason,
  }
}
