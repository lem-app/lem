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
 * Tests for HELLO negotiation and frame routing.
 *
 * The asymmetry that matters, and which the spec calls out: a v2 server does
 * not send a *wrong* HELLO, it sends **none at all** - it has no such frame,
 * and its dispatcher rejects 0x00 outright. The timeout is therefore the
 * mechanism that detects the realistic mismatch; the version check only catches
 * a future v4.
 */

/// <reference types="vitest/globals" />

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HTTPProxy, type Transport } from './proxy-fetch'
import { WSProxyManager } from './ws-proxy'
import {
  HELLO_TIMEOUT_MS,
  IMPL_NAME,
  MAX_PRE_HELLO_QUEUE,
  PROTOCOL_MISMATCH_MESSAGE,
  TunnelSession,
  WS_CODE_PROTOCOL_VERSION,
} from './tunnel-session'
import {
  FrameType,
  MAX_BODY_BYTES,
  MAX_CHUNK_BYTES,
  PROTOCOL_VERSION,
  deserializeHello,
  serializeCancel,
  serializeHello,
  serializeResponseHead,
} from './http-frame'
import type { LemProxyError } from './tunnel-errors'

class StubTransport implements Transport {
  open = true
  readonly sent: ArrayBuffer[] = []

  sendData(data: ArrayBuffer): void {
    this.sent.push(data)
  }

  isOpen(): boolean {
    return this.open
  }
}

function peerHello(
  version = PROTOCOL_VERSION,
  maxChunk = MAX_CHUNK_BYTES,
  maxBody = MAX_BODY_BYTES
): ArrayBuffer {
  return serializeHello({
    protocolVersion: version,
    flags: 0,
    maxChunkBytes: maxChunk,
    maxBodyBytes: maxBody,
    impl: 'lem-server/0.1.0',
  })
}

interface Harness {
  transport: StubTransport
  httpProxy: HTTPProxy
  wsProxyManager: WSProxyManager
  session: TunnelSession
  errors: LemProxyError[]
  closes: [number, string][]
}

function build(): Harness {
  const transport = new StubTransport()
  const httpProxy = new HTTPProxy(transport)
  const wsProxyManager = new WSProxyManager(transport)
  const errors: LemProxyError[] = []
  const closes: [number, string][] = []

  const session = new TunnelSession({
    transport,
    httpProxy,
    wsProxyManager,
    onProtocolError: (error) => errors.push(error),
    closeChannel: (code, reason) => closes.push([code, reason]),
  })

  return { transport, httpProxy, wsProxyManager, session, errors, closes }
}

describe('TunnelSession', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('sends HELLO as the first frame on the channel', () => {
    const { transport, session } = build()

    session.begin()

    expect(new Uint8Array(transport.sent[0])[0]).toBe(FrameType.HELLO)
    const sent = deserializeHello(transport.sent[0])
    expect(sent.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(sent.maxChunkBytes).toBe(MAX_CHUNK_BYTES)
    expect(sent.impl).toBe(IMPL_NAME)
  })

  it('negotiates the minimum of both advertised limits', () => {
    const { session, httpProxy } = build()
    session.begin()

    session.handleFrame(peerHello(PROTOCOL_VERSION, 8192, 1024))

    expect(session.negotiated).toBe(true)
    expect(httpProxy.effectiveMaxChunk).toBe(8192)
  })

  it('does not let a peer raise this side caps', () => {
    const { session, httpProxy } = build()
    session.begin()

    session.handleFrame(peerHello(PROTOCOL_VERSION, 10_000_000, 1 << 30))

    expect(httpProxy.effectiveMaxChunk).toBe(MAX_CHUNK_BYTES)
  })

  // The realistic v2 case.
  it('surfaces E_PROTO_VERSION and closes 4001 when no HELLO arrives', async () => {
    const { session, errors, closes } = build()
    session.begin()

    await vi.advanceTimersByTimeAsync(HELLO_TIMEOUT_MS + 10)

    expect(errors).toHaveLength(1)
    expect(errors[0].code).toBe('E_PROTO_VERSION')
    expect(errors[0].message).toBe(PROTOCOL_MISMATCH_MESSAGE)
    expect(errors[0].message).toMatch(/Update Lem/)
    expect(closes).toEqual([[WS_CODE_PROTOCOL_VERSION, 'protocol version mismatch']])
  })

  it('sends no request frames to a peer it cannot speak to', async () => {
    const { session, httpProxy, transport, errors } = build()
    session.begin()

    const pending = httpProxy.fetch('http://localhost:5142/v1/health')
    const assertion = expect(pending).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    const framesBeforeTimeout = transport.sent.length

    await vi.advanceTimersByTimeAsync(HELLO_TIMEOUT_MS + 10)
    await assertion

    expect(errors).toHaveLength(1)
    // Nothing new went out after the mismatch was detected.
    expect(transport.sent.length).toBe(framesBeforeTimeout)
    expect(httpProxy.pendingCount).toBe(0)
  })

  it('does not fire the timeout once a HELLO has arrived', async () => {
    const { session, errors, closes } = build()
    session.begin()

    session.handleFrame(peerHello())
    await vi.advanceTimersByTimeAsync(HELLO_TIMEOUT_MS * 2)

    expect(errors).toEqual([])
    expect(closes).toEqual([])
  })

  it('refuses a peer that speaks another protocol version', () => {
    const { session, errors, closes } = build()
    session.begin()

    session.handleFrame(peerHello(4))

    expect(session.negotiated).toBe(false)
    expect(errors[0].code).toBe('E_PROTO_VERSION')
    expect(errors[0].message).toMatch(/v4/)
    expect(closes).toEqual([[WS_CODE_PROTOCOL_VERSION, 'protocol version mismatch']])
  })

  it('queues frames that arrive before the peer HELLO and replays them', async () => {
    const { session, httpProxy } = build()
    session.begin()

    const pending = httpProxy.fetch('http://localhost:5142/v1/health')
    await vi.advanceTimersByTimeAsync(0)

    // A response head lands before negotiation finished.
    session.handleFrame(
      serializeResponseHead({ requestId: 1, statusCode: 200, headers: [], bodyFollows: false })
    )
    expect(httpProxy.pendingCount).toBe(1)

    session.handleFrame(peerHello())

    await expect(pending).resolves.toBeInstanceOf(Response)
  })

  it('closes the channel if a peer floods before HELLO', () => {
    const { session, closes } = build()
    session.begin()

    for (let index = 0; index <= MAX_PRE_HELLO_QUEUE; index += 1) {
      session.handleFrame(serializeCancel(1, 1000))
    }

    expect(closes).toEqual([[WS_CODE_PROTOCOL_VERSION, 'protocol version mismatch']])
  })

  it('reports a reserved v2 response frame as such', () => {
    const { session, errors, closes } = build()
    session.begin()
    session.handleFrame(peerHello())

    const v2Response = new Uint8Array([0x02, 0, 0, 0, 1, 0, 200])
    session.handleFrame(v2Response.buffer)

    expect(errors[0].code).toBe('E_PROTO_V2_FRAME')
    expect(closes).toEqual([[WS_CODE_PROTOCOL_VERSION, 'protocol version mismatch']])
  })

  it('routes HTTP and WebSocket frames to their owners', async () => {
    const { session, httpProxy, wsProxyManager, transport } = build()
    session.begin()
    session.handleFrame(peerHello())

    const pending = httpProxy.fetch('http://localhost:5142/v1/health')
    await vi.advanceTimersByTimeAsync(0)
    session.handleFrame(
      serializeResponseHead({ requestId: 1, statusCode: 204, headers: [], bodyFollows: false })
    )
    expect((await pending).status).toBe(204)

    const ws = wsProxyManager.createConnection('ws://localhost:3000/socket')
    await Promise.resolve()
    transport.sent.length = 0
    session.handleFrame(
      // WS_CONNECT_ACK for connection 1
      new Uint8Array([FrameType.WS_CONNECT_ACK, 0, 0, 0, 1, 0, 0]).buffer
    )
    expect(ws.readyState).toBe(1)
  })

  it('renegotiates from scratch after a reset', () => {
    const { session } = build()
    session.begin()
    session.handleFrame(peerHello())
    expect(session.negotiated).toBe(true)

    session.reset()

    expect(session.negotiated).toBe(false)
    expect(session.sentHello).toBe(false)
  })
})
