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
 * Tests for the streaming HTTP-over-tunnel proxy.
 *
 * The pending-request bookkeeping of F-COR-6 is still here; what is new is
 * that a response is a *stream*. The load-bearing property is that the
 * `Response` resolves on the head, before the body has finished arriving -
 * that is what makes a script tag execute early and model tokens paint as they
 * are generated.
 */

/// <reference types="vitest/globals" />

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HTTPProxy, type Transport } from './proxy-fetch'
import {
  FrameType,
  MAX_CHUNK_BYTES,
  deserializeChunk,
  deserializeRequestHead,
  serializeCancel,
  serializeResponseChunk,
  serializeResponseHead,
  type HeaderList,
} from './http-frame'
import { LemProxyError } from './tunnel-errors'

class StubTransport implements Transport {
  open = true
  throwOnSend: Error | null = null
  readonly sent: ArrayBuffer[] = []

  sendData(data: ArrayBuffer): void {
    if (this.throwOnSend) throw this.throwOnSend
    this.sent.push(data)
  }

  isOpen(): boolean {
    return this.open
  }

  frameTypes(): number[] {
    return this.sent.map((frame) => new Uint8Array(frame)[0])
  }
}

function head(
  requestId: number,
  statusCode = 200,
  headers: HeaderList = [],
  bodyFollows = true
): ArrayBuffer {
  return serializeResponseHead({ requestId, statusCode, headers, bodyFollows })
}

function chunk(requestId: number, text: string, final = false): ArrayBuffer {
  return serializeResponseChunk(requestId, new TextEncoder().encode(text), final)
}

describe('HTTPProxy', () => {
  let transport: StubTransport
  let proxy: HTTPProxy

  beforeEach(() => {
    vi.useFakeTimers()
    transport = new StubTransport()
    proxy = new HTTPProxy(transport)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('sends a REQUEST_HEAD with no body when there is nothing to send', async () => {
    const pending = proxy.fetch('http://localhost:5142/v1/health')
    await vi.advanceTimersByTimeAsync(0)

    expect(transport.frameTypes()).toEqual([FrameType.HTTP_REQUEST_HEAD])
    const frame = deserializeRequestHead(transport.sent[0])
    expect(frame.method).toBe('GET')
    expect(frame.path).toBe('/v1/health')
    expect(frame.bodyFollows).toBe(false)

    proxy.handleFrame(head(1, 200, [], false))
    await expect(pending).resolves.toBeInstanceOf(Response)
  })

  it('resolves the Response as soon as the head arrives', async () => {
    const pending = proxy.fetch('http://localhost:5142/v1/models')
    await vi.advanceTimersByTimeAsync(0)

    proxy.handleFrame(head(1, 200, [['Content-Type', 'application/json']]))

    // Resolved with no body chunk sent yet: this is the whole point.
    const response = await pending
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(proxy.pendingCount).toBe(1)

    proxy.handleFrame(chunk(1, '{"ok":true}', true))
    await expect(response.text()).resolves.toBe('{"ok":true}')
    expect(proxy.pendingCount).toBe(0)
  })

  // The product requirement: incremental arrival, not a size workaround.
  it('delivers chunks incrementally, before the response is complete', async () => {
    const pending = proxy.fetch('http://localhost:5142/api/chat')
    await vi.advanceTimersByTimeAsync(0)
    proxy.handleFrame(head(1))

    const response = await pending
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    proxy.handleFrame(chunk(1, 'token-1 '))
    const first = await reader.read()
    expect(decoder.decode(first.value)).toBe('token-1 ')
    expect(first.done).toBe(false)

    proxy.handleFrame(chunk(1, 'token-2 '))
    const second = await reader.read()
    expect(decoder.decode(second.value)).toBe('token-2 ')

    proxy.handleFrame(chunk(1, '', true))
    const end = await reader.read()
    expect(end.done).toBe(true)
  })

  it('preserves duplicate response headers', async () => {
    const pending = proxy.fetch('http://localhost:5142/login')
    await vi.advanceTimersByTimeAsync(0)
    proxy.handleFrame(
      head(1, 200, [
        ['Link', '<a>; rel=next'],
        ['Link', '<b>; rel=prev'],
      ])
    )

    const response = await pending
    expect(response.headers.get('link')).toContain('<a>; rel=next')
    expect(response.headers.get('link')).toContain('<b>; rel=prev')
  })

  it('carries a binary body byte for byte', async () => {
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xc3, 0x28])
    const pending = proxy.fetch('http://localhost:5142/logo.png')
    await vi.advanceTimersByTimeAsync(0)
    proxy.handleFrame(head(1))

    const response = await pending
    proxy.handleFrame(serializeResponseChunk(1, payload, false))
    proxy.handleFrame(serializeResponseChunk(1, new Uint8Array(0), true))

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload)
  })

  it('splits a large request body into chunks under the frame limit', async () => {
    const body = 'x'.repeat(MAX_CHUNK_BYTES * 2 + 100)
    void proxy.fetch('http://localhost:5142/upload', { method: 'POST', body })
    await vi.advanceTimersByTimeAsync(0)

    expect(transport.frameTypes()[0]).toBe(FrameType.HTTP_REQUEST_HEAD)
    expect(deserializeRequestHead(transport.sent[0]).bodyFollows).toBe(true)

    const chunks = transport.sent.slice(1).map((frame) => deserializeChunk(frame, MAX_CHUNK_BYTES))
    expect(chunks.length).toBe(3)
    expect(chunks.every((entry) => entry.payload.byteLength <= MAX_CHUNK_BYTES)).toBe(true)
    expect(chunks[chunks.length - 1].final).toBe(true)
    expect(chunks.reduce((sum, entry) => sum + entry.payload.byteLength, 0)).toBe(body.length)
  })

  it('sends a binary request body without stringifying it', async () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x10])
    void proxy.fetch('http://localhost:5142/upload', { method: 'POST', body: bytes })
    await vi.advanceTimersByTimeAsync(0)

    const chunkFrame = deserializeChunk(transport.sent[1], MAX_CHUNK_BYTES)
    expect(chunkFrame.payload).toEqual(bytes)
  })

  it('does not leak a pending entry when the transport is closed', async () => {
    transport.open = false

    await expect(proxy.fetch('http://localhost:5142/v1/health')).rejects.toThrow(
      'Transport not open'
    )
    expect(proxy.pendingCount).toBe(0)
  })

  it('does not leak a pending entry when sendData throws', async () => {
    transport.throwOnSend = new Error('DataChannel not open')

    await expect(proxy.fetch('http://localhost:5142/v1/health')).rejects.toThrow(
      'DataChannel not open'
    )
    expect(proxy.pendingCount).toBe(0)
  })

  it('does not accumulate pending entries across repeated failures', async () => {
    transport.throwOnSend = new Error('DataChannel not open')

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await expect(proxy.fetch('http://localhost:5142/v1/health')).rejects.toThrow()
    }

    expect(proxy.pendingCount).toBe(0)
  })

  it('fails a request that never gets a head', async () => {
    const pending = proxy.fetch('http://localhost:5142/v1/health')
    const assertion = expect(pending).rejects.toThrow('E_TIMEOUT_HEAD')

    await vi.advanceTimersByTimeAsync(30_000)
    await assertion

    expect(proxy.pendingCount).toBe(0)
  })

  // v2 killed any generation longer than its single 30s clock, however healthy.
  it('does not time out a long stream that keeps producing chunks', async () => {
    const pending = proxy.fetch('http://localhost:5142/api/generate')
    await vi.advanceTimersByTimeAsync(0)
    proxy.handleFrame(head(1))
    const response = await pending
    const reader = response.body!.getReader()

    // Five minutes of generation, a token every two seconds.
    for (let tick = 0; tick < 150; tick += 1) {
      await vi.advanceTimersByTimeAsync(2_000)
      proxy.handleFrame(chunk(1, `t${tick} `))
      const next = await reader.read()
      expect(next.done).toBe(false)
    }

    proxy.handleFrame(chunk(1, '', true))
    expect((await reader.read()).done).toBe(true)
  })

  it('errors a stalled stream after the idle timeout', async () => {
    const pending = proxy.fetch('http://localhost:5142/api/generate')
    await vi.advanceTimersByTimeAsync(0)
    proxy.handleFrame(head(1))
    const response = await pending
    const reader = response.body!.getReader()

    proxy.handleFrame(chunk(1, 'partial'))
    await reader.read()

    const assertion = expect(reader.read()).rejects.toThrow('E_TIMEOUT_STREAM')
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
  })

  // Spec 5.5.1: error(), never close(). A closed stream hands the app a
  // truncated body it believes is complete.
  it('errors the stream when the cumulative body cap is breached', async () => {
    proxy.setNegotiatedLimits(MAX_CHUNK_BYTES, 8)
    const pending = proxy.fetch('http://localhost:5142/big')
    await vi.advanceTimersByTimeAsync(0)
    proxy.handleFrame(head(1))
    const response = await pending
    const reader = response.body!.getReader()

    proxy.handleFrame(chunk(1, '12345'))
    await reader.read()

    const assertion = expect(reader.read()).rejects.toThrow('E_TOO_LARGE')
    proxy.handleFrame(chunk(1, '67890'))
    await assertion

    // And the server is told to stop producing.
    expect(transport.frameTypes()).toContain(FrameType.HTTP_CANCEL)
  })

  it('errors the stream on an inbound cancel rather than closing it', async () => {
    const pending = proxy.fetch('http://localhost:5142/big')
    await vi.advanceTimersByTimeAsync(0)
    proxy.handleFrame(head(1))
    const response = await pending
    const reader = response.body!.getReader()

    proxy.handleFrame(chunk(1, 'partial'))
    await reader.read()

    const assertion = expect(reader.read()).rejects.toThrow('E_TOO_LARGE')
    proxy.handleFrame(serializeCancel(1, 1008))
    await assertion
  })

  it('rejects a fetch whose head never arrived when the peer cancels', async () => {
    const pending = proxy.fetch('http://localhost:5142/thing')
    await vi.advanceTimersByTimeAsync(0)

    const assertion = expect(pending).rejects.toBeInstanceOf(LemProxyError)
    proxy.handleFrame(serializeCancel(1, 1012))
    await assertion
  })

  it('sends a cancel when the caller aborts', async () => {
    const controller = new AbortController()
    const pending = proxy.fetch('http://localhost:5142/slow', { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)

    const assertion = expect(pending).rejects.toThrow('Aborted')
    controller.abort()
    await assertion

    expect(transport.frameTypes()).toContain(FrameType.HTTP_CANCEL)
  })

  it('rejects every outstanding request when the connection closes', async () => {
    const first = proxy.fetch('http://localhost:5142/v1/health')
    const second = proxy.fetch('http://localhost:5142/v1/services')
    await vi.advanceTimersByTimeAsync(0)
    expect(proxy.pendingCount).toBe(2)

    const assertions = Promise.all([
      expect(first).rejects.toThrow('Connection closed'),
      expect(second).rejects.toThrow('Connection closed'),
    ])
    proxy.clearPending()
    await assertions

    expect(proxy.pendingCount).toBe(0)
  })

  it('errors an in-flight stream when the connection closes', async () => {
    const pending = proxy.fetch('http://localhost:5142/stream')
    await vi.advanceTimersByTimeAsync(0)
    proxy.handleFrame(head(1))
    const response = await pending
    const reader = response.body!.getReader()

    const assertion = expect(reader.read()).rejects.toThrow('Connection closed')
    proxy.clearPending()
    await assertion
  })

  it('ignores frames for unknown request ids', async () => {
    const pending = proxy.fetch('http://localhost:5142/v1/health')
    await vi.advanceTimersByTimeAsync(0)

    proxy.handleFrame(head(999))
    expect(proxy.pendingCount).toBe(1)

    proxy.handleFrame(head(1, 200, [], false))
    await pending
    expect(proxy.pendingCount).toBe(0)
  })

  it('does not claim frames that belong to the WebSocket proxy', () => {
    const wsFrame = new Uint8Array([FrameType.WS_DATA, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0])

    expect(proxy.handleFrame(wsFrame.buffer)).toBe(false)
  })

  it('routes requests through a swapped transport', async () => {
    const relay = new StubTransport()
    proxy.setTransport(relay)

    const pending = proxy.fetch('http://localhost:5142/v1/health')
    await vi.advanceTimersByTimeAsync(0)
    expect(relay.sent).toHaveLength(1)
    expect(transport.sent).toHaveLength(0)

    proxy.handleFrame(head(1, 200, [], false))
    await pending
  })

  it('clamps negotiated limits to its own caps', () => {
    proxy.setNegotiatedLimits(10_000_000, 1 << 30)

    expect(proxy.effectiveMaxChunk).toBe(MAX_CHUNK_BYTES)
  })
})
