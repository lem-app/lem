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
 * Tests for the connection lifecycle the hook owns (F-COR-1, F-COR-3).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useWebRTC } from './useWebRTC'
import {
  FakePeerConnection,
  fakeSockets,
  installFakeWebRTC,
  installFakeWebSocket,
  latestSocket,
} from '../test/fakes'

const HOOK_OPTIONS = {
  signalUrl: 'ws://signal.test/signal',
  token: 'jwt-token',
  deviceId: 'browser-1',
  targetDeviceId: 'device-1',
  relayUrl: 'ws://relay.test',
}

/** Complete the signaling handshake for whichever socket was opened last. */
function completeSignaling(): void {
  const socket = latestSocket()
  socket.open()
  socket.receiveText({ type: 'connected', device_id: 'browser-1', message: 'ok' })
}

describe('useWebRTC lifecycle', () => {
  beforeEach(() => {
    installFakeWebSocket()
    installFakeWebRTC()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('connects and reports the WebRTC transport', async () => {
    const { result } = renderHook(() => useWebRTC(HOOK_OPTIONS))

    await act(async () => {
      void result.current.connect()
      await Promise.resolve()
      completeSignaling()
    })

    await waitFor(() => {
      expect(fakeSockets.length).toBeGreaterThan(0)
    })
    expect(result.current.connectionMode).toBe('webrtc')
  })

  // F-COR-1: disconnect() only closed the WebRTC manager; on the relay path the
  // relay socket stayed open and kept reconnecting behind a "disconnected" UI.
  it('closes the relay transport and resets transport bookkeeping on disconnect', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useWebRTC(HOOK_OPTIONS))

    await act(async () => {
      void result.current.connect()
      await Promise.resolve()
      completeSignaling()
    })

    // Force the WebRTC leg to fail so the hook falls back to the relay.
    await act(async () => {
      const pc = FakePeerConnection.instances[0]
      pc.connectionState = 'failed'
      pc.onconnectionstatechange?.()
      await Promise.resolve()
    })

    // Answer the connect-request so the relay client is actually created.
    await act(async () => {
      latestSocket().receiveText({
        type: 'connect-ack-received',
        from_device_id: 'device-1',
        transport: 'relay',
        relay_session_id: 'browser-1-device-1',
        status: 'connecting',
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    const relaySocket = fakeSockets.find((socket) => socket.url.includes('/relay/'))
    expect(relaySocket).toBeDefined()
    if (!relaySocket) return

    await act(async () => {
      relaySocket.open()
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(result.current.connectionMode).toBe('relay')

    const socketsBeforeDisconnect = fakeSockets.length

    act(() => {
      result.current.disconnect()
    })

    // The relay socket is genuinely closed...
    expect(relaySocket.closeCalls).toBeGreaterThan(0)
    expect(relaySocket.onmessage).toBeNull()

    // ...and it does not come back on the reconnect timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(fakeSockets.length).toBe(socketsBeforeDisconnect)

    // Transport bookkeeping is back to its initial state, so the next
    // connection is not mislabelled and the poller reads the right transport.
    expect(result.current.connectionMode).toBe('webrtc')
    expect(result.current.connectionState).toBe('disconnected')
    expect(result.current.dataChannelState).toBe('none')
  })

  // F-COR-3: relay fallback should follow the 10s timeout, not 60s+.
  it('falls back to the relay as soon as the connection timeout fires', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useWebRTC(HOOK_OPTIONS))

    await act(async () => {
      void result.current.connect()
      await Promise.resolve()
      completeSignaling()
    })

    expect(result.current.connectionMode).toBe('webrtc')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(result.current.connectionMode).toBe('relay')

    const connectRequests = fakeSockets[0]
      .sentJson()
      .filter((message) => message.type === 'connect-request')
    expect(connectRequests).toHaveLength(1)
    expect(connectRequests[0]).toMatchObject({ preferred_transport: 'relay' })

    act(() => {
      result.current.disconnect()
    })
  })

  it('surfaces an error instead of rejecting when connect fails', async () => {
    const { result } = renderHook(() => useWebRTC(HOOK_OPTIONS))

    // connect() must never reject: it is wired straight to an onClick, and a
    // rejected promise there is an unhandled rejection.
    let connecting: Promise<void> | null = null
    await act(async () => {
      connecting = result.current.connect()
      await Promise.resolve()
      latestSocket().serverClose(1006)
    })

    await expect(connecting).resolves.toBeUndefined()

    await waitFor(() => {
      expect(result.current.error).not.toBeNull()
    })
  })
})
