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
 * Tests for the HTTP-over-tunnel proxy, in particular the pending-request
 * bookkeeping (F-COR-6).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HTTPProxy, type Transport } from './proxy-fetch'
import { serializeResponse } from './http-frame'

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
}

function responseFrame(requestId: number, statusCode = 200, body = '{"ok":true}'): ArrayBuffer {
  return serializeResponse({ requestId, statusCode, headers: {}, body })
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

  it('resolves a request when the matching response frame arrives', async () => {
    const pending = proxy.fetch('http://localhost:5142/v1/health')
    expect(proxy.pendingCount).toBe(1)

    proxy.handleResponse(responseFrame(1))

    const response = await pending
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('{"ok":true}')
    expect(proxy.pendingCount).toBe(0)
  })

  // F-COR-6: the catch used to delete the entry and then fall through to code
  // that re-inserted it, so every send failure leaked a resolver forever.
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

    for (let i = 0; i < 25; i += 1) {
      await expect(proxy.fetch('http://localhost:5142/v1/health')).rejects.toThrow()
    }

    expect(proxy.pendingCount).toBe(0)
  })

  it('times out and clears the pending entry', async () => {
    const pending = proxy.fetch('http://localhost:5142/v1/health')
    const assertion = expect(pending).rejects.toThrow('Request timeout')

    await vi.advanceTimersByTimeAsync(30_000)
    await assertion

    expect(proxy.pendingCount).toBe(0)
  })

  it('clears the timeout once a response arrives, so no late rejection fires', async () => {
    const pending = proxy.fetch('http://localhost:5142/v1/health')
    proxy.handleResponse(responseFrame(1))
    await pending

    // If the timeout were still armed it would reject an already-settled
    // promise and, worse, delete a newer request's entry.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(proxy.pendingCount).toBe(0)
  })

  it('rejects every outstanding request when the connection closes', async () => {
    const first = proxy.fetch('http://localhost:5142/v1/health')
    const second = proxy.fetch('http://localhost:5142/v1/services')
    expect(proxy.pendingCount).toBe(2)

    const assertions = Promise.all([
      expect(first).rejects.toThrow('Connection closed'),
      expect(second).rejects.toThrow('Connection closed'),
    ])
    proxy.clearPending()
    await assertions

    expect(proxy.pendingCount).toBe(0)
  })

  it('ignores responses for unknown request ids', async () => {
    const pending = proxy.fetch('http://localhost:5142/v1/health')

    proxy.handleResponse(responseFrame(999))
    expect(proxy.pendingCount).toBe(1)

    proxy.handleResponse(responseFrame(1))
    await pending
    expect(proxy.pendingCount).toBe(0)
  })

  it('routes requests through a swapped transport', async () => {
    const relay = new StubTransport()
    proxy.setTransport(relay)

    const pending = proxy.fetch('http://localhost:5142/v1/health')
    expect(relay.sent).toHaveLength(1)
    expect(transport.sent).toHaveLength(0)

    proxy.handleResponse(responseFrame(1))
    await pending
  })
})
