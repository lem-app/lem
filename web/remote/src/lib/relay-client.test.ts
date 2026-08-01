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
 * Tests for the WebSocket relay client (F-COR-2, F-COR-5).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RelayClient, RelayAuthError, RelayRejectedError } from './relay-client'
import { installFakeWebSocket, latestSocket, fakeSockets } from '../test/fakes'
import type { ConnectionState } from '../api/types'

function newClient(onState?: (state: ConnectionState) => void, onError?: (e: Error) => void) {
  return new RelayClient({
    relayUrl: 'ws://relay.test',
    sessionId: 'browser-1-device-1',
    token: 'jwt-token',
    onStateChange: onState,
    onError,
  })
}

describe('RelayClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installFakeWebSocket()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('sends auth on open but does not report connected yet', async () => {
    const states: ConnectionState[] = []
    const client = newClient((state) => states.push(state))

    const connecting = client.connect()
    await Promise.resolve()

    const socket = latestSocket()
    expect(socket.url).toBe('ws://relay.test/relay/browser-1-device-1')

    socket.open()
    expect(socket.sentJson()[0]).toEqual({ type: 'auth', token: 'jwt-token' })

    // No positive ack has arrived, so the client must not claim success.
    expect(client.getState()).toBe('connecting')
    expect(client.isConnected()).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000)
    await connecting

    expect(client.getState()).toBe('connected')
    expect(states).toEqual(['connecting', 'connected'])

    client.disconnect()
  })

  // F-COR-5: an expired JWT used to paint the UI green and loop forever.
  it('surfaces an auth failure from the 1008 close code and stops reconnecting', async () => {
    const client = newClient()
    const connecting = client.connect()
    await Promise.resolve()

    const socket = latestSocket()
    socket.open()
    socket.serverClose(1008, 'Authentication failed')

    await expect(connecting).rejects.toBeInstanceOf(RelayAuthError)
    expect(client.getState()).toBe('failed')

    const socketsAtFailure = fakeSockets.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fakeSockets.length).toBe(socketsAtFailure)
  })

  // F-COR-5: the relay's explicit error control frame, before any close.
  it('surfaces an auth failure from an error control frame', async () => {
    const client = newClient()
    const connecting = client.connect()
    await Promise.resolve()

    const socket = latestSocket()
    socket.open()
    socket.receiveText({ type: 'error', message: 'Authentication failed' })

    await expect(connecting).rejects.toThrow('Authentication failed')
    expect(client.isConnected()).toBe(false)
  })

  // The relay's error frame now carries `reason` and `retryable` (PR #45).
  // Treating every error frame as terminal turned "the relay is busy" into
  // "sign in again" and disabled relay reconnection for the session.
  it('retries after a retryable capacity rejection instead of giving up', async () => {
    const errors: Error[] = []
    const client = newClient(undefined, (error) => errors.push(error))
    const connecting = client.connect()
    await Promise.resolve()

    const socket = latestSocket()
    socket.open()
    socket.receiveText({
      type: 'error',
      message: 'Relay is at capacity',
      reason: 'relay-at-capacity',
      retryable: true,
    })
    // The relay closes with 1013 "try again later" right after the frame.
    socket.serverClose(1013, 'Relay is at capacity')

    await expect(connecting).rejects.toBeInstanceOf(RelayRejectedError)
    await expect(connecting).rejects.not.toBeInstanceOf(RelayAuthError)

    // The whole point: reconnection is still armed.
    const socketsAtRejection = fakeSockets.length
    await vi.advanceTimersByTimeAsync(2_500)
    expect(fakeSockets.length).toBe(socketsAtRejection + 1)

    client.disconnect()
  })

  it('does not tell the user to sign in again when the relay is merely busy', async () => {
    const errors: Error[] = []
    const client = newClient(undefined, (error) => errors.push(error))
    const connecting = client.connect()
    await Promise.resolve()

    const socket = latestSocket()
    socket.open()
    socket.receiveText({
      type: 'error',
      message: '',
      reason: 'account-session-limit',
      retryable: true,
    })

    let captured: unknown
    await connecting.catch((e: unknown) => {
      captured = e
    })
    const error = captured as RelayRejectedError
    expect(error).toBeInstanceOf(RelayRejectedError)
    expect(error.reason).toBe('account-session-limit')
    expect(error.retryable).toBe(true)
    expect(error.message).not.toMatch(/sign in/i)
    expect(error.message).toMatch(/concurrent relay sessions|relay sessions/i)

    client.disconnect()
  })

  it('still stops reconnecting on a terminal auth rejection', async () => {
    const client = newClient()
    const connecting = client.connect()
    await Promise.resolve()

    const socket = latestSocket()
    socket.open()
    socket.receiveText({
      type: 'error',
      message: 'Authentication failed',
      reason: 'auth-failed',
      retryable: false,
    })
    socket.serverClose(1008, 'Authentication failed')

    await expect(connecting).rejects.toBeInstanceOf(RelayAuthError)

    const socketsAtFailure = fakeSockets.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fakeSockets.length).toBe(socketsAtFailure)
    expect(client.getState()).toBe('failed')
  })

  it('stops reconnecting on a terminal non-auth rejection with its own message', async () => {
    const client = newClient()
    const connecting = client.connect()
    await Promise.resolve()

    const socket = latestSocket()
    socket.open()
    socket.receiveText({
      type: 'error',
      message: 'Update your Lem client',
      reason: 'unsupported-client',
      retryable: false,
    })

    let captured: unknown
    await connecting.catch((e: unknown) => {
      captured = e
    })
    const error = captured as RelayRejectedError
    expect(error).toBeInstanceOf(RelayRejectedError)
    expect(error).not.toBeInstanceOf(RelayAuthError)
    expect(error.reason).toBe('unsupported-client')
    expect(error.message).toBe('Update your Lem client')

    const socketsAtFailure = fakeSockets.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fakeSockets.length).toBe(socketsAtFailure)
  })

  it('treats a 1013 close with no error frame as retryable', async () => {
    const client = newClient()
    const connecting = client.connect()
    await Promise.resolve()

    const socket = latestSocket()
    socket.open()
    socket.serverClose(1013, 'Relay is at capacity')

    await expect(connecting).rejects.not.toBeInstanceOf(RelayAuthError)

    const socketsAtClose = fakeSockets.length
    await vi.advanceTimersByTimeAsync(2_500)
    expect(fakeSockets.length).toBe(socketsAtClose + 1)

    client.disconnect()
  })

  // Forward compatibility with an explicit ack, should the relay grow one.
  it('reports connected immediately on an explicit ack', async () => {
    const client = newClient()
    const connecting = client.connect()
    await Promise.resolve()

    const socket = latestSocket()
    socket.open()
    socket.receiveText({ type: 'connected' })

    await connecting
    expect(client.getState()).toBe('connected')

    client.disconnect()
  })

  it('treats the first binary frame as proof the tunnel is live', async () => {
    const received: ArrayBuffer[] = []
    const client = new RelayClient({
      relayUrl: 'ws://relay.test',
      sessionId: 's',
      token: 't',
      onMessage: (message) => received.push(message),
    })

    const connecting = client.connect()
    await Promise.resolve()

    const socket = latestSocket()
    socket.open()
    socket.receiveBinary(new Uint8Array([0x02, 0x00]).buffer)

    await connecting
    expect(client.getState()).toBe('connected')
    expect(received).toHaveLength(1)

    client.disconnect()
  })

  // F-COR-2
  it('cancels a scheduled reconnect when disconnect() lands first', async () => {
    const client = newClient()
    const connecting = client.connect()
    await Promise.resolve()

    const socket = latestSocket()
    socket.open()
    await vi.advanceTimersByTimeAsync(1_000)
    await connecting

    // Transport drops -> reconnect scheduled at +2s.
    socket.serverClose(1006)
    const socketsAfterDrop = fakeSockets.length

    // User disconnects at +0.5s.
    await vi.advanceTimersByTimeAsync(500)
    client.disconnect()

    await vi.advanceTimersByTimeAsync(10_000)

    expect(fakeSockets.length).toBe(socketsAfterDrop)
    expect(client.getState()).toBe('disconnected')
  })

  it('reconnects after an unexpected close', async () => {
    const client = newClient()
    const connecting = client.connect()
    await Promise.resolve()

    const socket = latestSocket()
    socket.open()
    await vi.advanceTimersByTimeAsync(1_000)
    await connecting

    const socketsBefore = fakeSockets.length
    socket.serverClose(1006)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(fakeSockets.length).toBe(socketsBefore + 1)

    client.disconnect()
  })

  // Reconnecting forever with no visible error is worse than a visible error.
  it('gives up and reports an error after the reconnect cap', async () => {
    const errors: Error[] = []
    const client = newClient(undefined, (error) => errors.push(error))

    const connecting = client.connect()
    await Promise.resolve()
    latestSocket().open()
    await vi.advanceTimersByTimeAsync(1_000)
    await connecting

    for (let attempt = 0; attempt < 8; attempt += 1) {
      latestSocket().serverClose(1006)
      await vi.advanceTimersByTimeAsync(120_000)
    }

    expect(errors.some((error) => error.message.includes('reconnect attempts'))).toBe(true)
    expect(client.getState()).toBe('failed')

    client.disconnect()
  })

  it('detaches handlers from the old socket on disconnect', async () => {
    const client = newClient()
    const connecting = client.connect()
    await Promise.resolve()

    const socket = latestSocket()
    socket.open()
    await vi.advanceTimersByTimeAsync(1_000)
    await connecting

    client.disconnect()

    expect(socket.closeCalls).toBe(1)
    expect(socket.onclose).toBeNull()
    expect(socket.onmessage).toBeNull()
    expect(() => client.sendData(new ArrayBuffer(1))).toThrow('WebSocket not open')
  })
})
