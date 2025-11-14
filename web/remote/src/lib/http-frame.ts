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
 * HTTP-over-DataChannel frame serialization/deserialization.
 *
 * Binary frame format (version 2 - with frame type):
 * - 1 byte: frame_type (uint8)
 *   - 0x01 = HTTP_REQUEST
 *   - 0x02 = HTTP_RESPONSE
 *   - 0x10 = WS_CONNECT (future)
 *   - 0x11 = WS_DATA (future)
 *   - 0x12 = WS_CLOSE (future)
 *
 * Binary frame format for HTTP requests:
 * - 1 byte: frame_type (0x01)
 * - 4 bytes: request_id (uint32)
 * - 2 bytes: method_len (uint16)
 * - method_len bytes: HTTP method (GET, POST, etc.)
 * - 2 bytes: path_len (uint16)
 * - path_len bytes: HTTP path
 * - 4 bytes: headers_len (uint32)
 * - headers_len bytes: JSON headers
 * - 4 bytes: body_len (uint32)
 * - body_len bytes: HTTP body
 *
 * Binary frame format for HTTP responses:
 * - 1 byte: frame_type (0x02)
 * - 4 bytes: request_id (uint32)
 * - 2 bytes: status_code (uint16)
 * - 4 bytes: headers_len (uint32)
 * - headers_len bytes: JSON headers
 * - 4 bytes: body_len (uint32)
 * - body_len bytes: HTTP body
 */

/**
 * Frame type constants.
 */
export const FrameType = {
  HTTP_REQUEST: 0x01,
  HTTP_RESPONSE: 0x02,
  WS_CONNECT: 0x10,
  WS_DATA: 0x11,
  WS_CLOSE: 0x12,
} as const

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType]

/**
 * HTTP request frame.
 */
export interface HTTPRequestFrame {
  requestId: number
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

/**
 * HTTP response frame.
 */
export interface HTTPResponseFrame {
  requestId: number
  statusCode: number
  headers: Record<string, string>
  body: string
}

/**
 * Text encoder/decoder for UTF-8 conversion.
 */
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * Serialize HTTP request to binary frame.
 */
export function serializeRequest(frame: HTTPRequestFrame): ArrayBuffer {
  // Encode strings to UTF-8
  const methodBytes = textEncoder.encode(frame.method)
  const pathBytes = textEncoder.encode(frame.path)
  const headersBytes = textEncoder.encode(JSON.stringify(frame.headers))
  const bodyBytes = textEncoder.encode(frame.body)

  // Calculate total size (add 1 byte for frame type)
  const totalSize =
    1 + // frame_type
    4 + // request_id
    2 +
    methodBytes.length + // method_len + method
    2 +
    pathBytes.length + // path_len + path
    4 +
    headersBytes.length + // headers_len + headers
    4 +
    bodyBytes.length // body_len + body

  // Create buffer
  const buffer = new ArrayBuffer(totalSize)
  const view = new DataView(buffer)
  let offset = 0

  // Write frame_type (uint8)
  view.setUint8(offset, FrameType.HTTP_REQUEST)
  offset += 1

  // Write request_id (uint32)
  view.setUint32(offset, frame.requestId, false) // big-endian
  offset += 4

  // Write method_len (uint16) and method
  view.setUint16(offset, methodBytes.length, false)
  offset += 2
  new Uint8Array(buffer, offset, methodBytes.length).set(methodBytes)
  offset += methodBytes.length

  // Write path_len (uint16) and path
  view.setUint16(offset, pathBytes.length, false)
  offset += 2
  new Uint8Array(buffer, offset, pathBytes.length).set(pathBytes)
  offset += pathBytes.length

  // Write headers_len (uint32) and headers
  view.setUint32(offset, headersBytes.length, false)
  offset += 4
  new Uint8Array(buffer, offset, headersBytes.length).set(headersBytes)
  offset += headersBytes.length

  // Write body_len (uint32) and body
  view.setUint32(offset, bodyBytes.length, false)
  offset += 4
  new Uint8Array(buffer, offset, bodyBytes.length).set(bodyBytes)

  return buffer
}

/**
 * Deserialize binary frame to HTTP response.
 */
export function deserializeResponse(buffer: ArrayBuffer): HTTPResponseFrame {
  const view = new DataView(buffer)
  let offset = 0

  // Read frame_type (uint8) and validate
  const frameType = view.getUint8(offset)
  offset += 1

  if (frameType !== FrameType.HTTP_RESPONSE) {
    throw new Error(`Expected HTTP_RESPONSE frame (0x02), got 0x${frameType.toString(16)}`)
  }

  // Read request_id (uint32)
  const requestId = view.getUint32(offset, false)
  offset += 4

  // Read status_code (uint16)
  const statusCode = view.getUint16(offset, false)
  offset += 2

  // Read headers_len (uint32) and headers
  const headersLen = view.getUint32(offset, false)
  offset += 4
  const headersBytes = new Uint8Array(buffer, offset, headersLen)
  const headersJson = textDecoder.decode(headersBytes)
  const headers = JSON.parse(headersJson) as Record<string, string>
  offset += headersLen

  // Read body_len (uint32) and body
  const bodyLen = view.getUint32(offset, false)
  offset += 4
  const bodyBytes = new Uint8Array(buffer, offset, bodyLen)
  const body = textDecoder.decode(bodyBytes)

  return {
    requestId,
    statusCode,
    headers,
    body,
  }
}

/**
 * Serialize HTTP response to binary frame (for testing).
 */
export function serializeResponse(frame: HTTPResponseFrame): ArrayBuffer {
  // Encode strings to UTF-8
  const headersBytes = textEncoder.encode(JSON.stringify(frame.headers))
  const bodyBytes = textEncoder.encode(frame.body)

  // Calculate total size (add 1 byte for frame type)
  const totalSize =
    1 + // frame_type
    4 + // request_id
    2 + // status_code
    4 +
    headersBytes.length + // headers_len + headers
    4 +
    bodyBytes.length // body_len + body

  // Create buffer
  const buffer = new ArrayBuffer(totalSize)
  const view = new DataView(buffer)
  let offset = 0

  // Write frame_type (uint8)
  view.setUint8(offset, FrameType.HTTP_RESPONSE)
  offset += 1

  // Write request_id (uint32)
  view.setUint32(offset, frame.requestId, false)
  offset += 4

  // Write status_code (uint16)
  view.setUint16(offset, frame.statusCode, false)
  offset += 2

  // Write headers_len (uint32) and headers
  view.setUint32(offset, headersBytes.length, false)
  offset += 4
  new Uint8Array(buffer, offset, headersBytes.length).set(headersBytes)
  offset += headersBytes.length

  // Write body_len (uint32) and body
  view.setUint32(offset, bodyBytes.length, false)
  offset += 4
  new Uint8Array(buffer, offset, bodyBytes.length).set(bodyBytes)

  return buffer
}

/**
 * Deserialize binary frame to HTTP request (for testing).
 */
export function deserializeRequest(buffer: ArrayBuffer): HTTPRequestFrame {
  const view = new DataView(buffer)
  let offset = 0

  // Read frame_type (uint8) and validate
  const frameType = view.getUint8(offset)
  offset += 1

  if (frameType !== FrameType.HTTP_REQUEST) {
    throw new Error(`Expected HTTP_REQUEST frame (0x01), got 0x${frameType.toString(16)}`)
  }

  // Read request_id (uint32)
  const requestId = view.getUint32(offset, false)
  offset += 4

  // Read method_len (uint16) and method
  const methodLen = view.getUint16(offset, false)
  offset += 2
  const methodBytes = new Uint8Array(buffer, offset, methodLen)
  const method = textDecoder.decode(methodBytes)
  offset += methodLen

  // Read path_len (uint16) and path
  const pathLen = view.getUint16(offset, false)
  offset += 2
  const pathBytes = new Uint8Array(buffer, offset, pathLen)
  const path = textDecoder.decode(pathBytes)
  offset += pathLen

  // Read headers_len (uint32) and headers
  const headersLen = view.getUint32(offset, false)
  offset += 4
  const headersBytes = new Uint8Array(buffer, offset, headersLen)
  const headersJson = textDecoder.decode(headersBytes)
  const headers = JSON.parse(headersJson) as Record<string, string>
  offset += headersLen

  // Read body_len (uint32) and body
  const bodyLen = view.getUint32(offset, false)
  offset += 4
  const bodyBytes = new Uint8Array(buffer, offset, bodyLen)
  const body = textDecoder.decode(bodyBytes)

  return {
    requestId,
    method,
    path,
    headers,
    body,
  }
}
