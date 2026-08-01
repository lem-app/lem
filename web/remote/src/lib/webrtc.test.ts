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
 * Tests for the WebRTC connection manager.
 *
 * These drive the real signaling handshake through a fake socket rather than
 * asserting `getState() === 'disconnected'` on a freshly constructed object.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebRTCConnectionManager } from './webrtc'
import {
  FakePeerConnection,
  installFakeWebRTC,
  installFakeWebSocket,
  latestSocket,
  fakeSockets,
} from '../test/fakes'
import type { ConnectionState } from '../api/types'

const SIGNAL_URL = 'ws://signal.test/signal'

function newManager(
  overrides: Partial<{
    onStateChange: (s: ConnectionState) => void
    onError: (e: Error) => void
    onConnectionFailed: (e: Error) => void
    signChallenge: (context: string, ...fields: string[]) => Promise<string>
  }> = {}
) {
  return new WebRTCConnectionManager({
    signalUrl: SIGNAL_URL,
    token: 'test-token',
    deviceId: 'browser-1',
    targetDeviceId: 'device-1',
    // Real WebCrypto signing is exercised in `api/device-key.test.ts`; here we
    // only care that the handshake step happens at all.
    signChallenge: (context, ...fields) => Promise.resolve(`sig(${context}|${fields.join('|')})`),
    ...overrides,
  })
}

/**
 * Run `connect()` through the full signaling handshake:
 * `auth` -> `challenge` -> `auth-response` -> `connected`.
 *
 * Returns the connect() promise so callers can await completion.
 */
async function connectThroughSignaling(manager: WebRTCConnectionManager): Promise<void> {
  const connecting = manager.connect()
  await Promise.resolve()

  const socket = latestSocket()
  socket.open()
  socket.receiveText({
    type: 'challenge',
    device_id: 'browser-1',
    challenge: 'Y2hhbGxlbmdl',
    context: 'lem-signaling-connect-v1',
  })
  // Signing is async; let the auth-response be sent before `connected` lands.
  await vi.advanceTimersByTimeAsync(0)
  socket.receiveText({ type: 'connected', device_id: 'browser-1', message: 'ok' })

  await connecting
}

describe('WebRTCConnectionManager signaling', () => {
  let manager: WebRTCConnectionManager

  beforeEach(() => {
    vi.useFakeTimers()
    installFakeWebSocket()
    installFakeWebRTC()
    manager = newManager()
  })

  afterEach(() => {
    manager.disconnect()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('authenticates, sends an offer and reports connected on the peer connection', async () => {
    const states: ConnectionState[] = []
    manager = newManager({ onStateChange: (state) => states.push(state) })

    await connectThroughSignaling(manager)

    const messages = latestSocket().sentJson()
    expect(messages[0]).toMatchObject({ type: 'auth', token: 'test-token' })
    expect(messages[1]).toMatchObject({ type: 'auth-response' })
    expect(messages[2]).toMatchObject({ type: 'offer', target_device_id: 'device-1' })

    const pc = FakePeerConnection.instances[0]
    pc.connectionState = 'connected'
    pc.onconnectionstatechange?.()

    expect(manager.getState()).toBe('connected')
    expect(states).toEqual(['connecting', 'connected'])
  })

  it('answers the proof-of-possession challenge before anything else', async () => {
    // The browser used to send `auth` and wait for `connected`, which never
    // came: the server answers `auth` with a challenge and closes the socket
    // if it goes unanswered. Nothing signed the challenge.
    const connecting = manager.connect()
    await Promise.resolve()

    const socket = latestSocket()
    socket.open()
    socket.receiveText({
      type: 'challenge',
      device_id: 'browser-1',
      challenge: 'Y2hhbGxlbmdl',
      context: 'lem-signaling-connect-v1',
    })
    await vi.advanceTimersByTimeAsync(0)

    const response = socket.sentJson()[1]
    expect(response).toEqual({
      type: 'auth-response',
      // Domain-separated, and bound to this device and this challenge.
      signature: 'sig(lem-signaling-connect-v1|browser-1|Y2hhbGxlbmdl)',
    })

    socket.receiveText({ type: 'connected', device_id: 'browser-1', message: 'ok' })
    await connecting
  })

  it('closes the socket when it cannot sign the challenge', async () => {
    // Fail closed: no key, no connection. Never "proceed unauthenticated".
    const errors: Error[] = []
    manager = newManager({
      signChallenge: () => Promise.reject(new Error('no device key')),
      onError: (error) => errors.push(error),
    })

    void manager.connect()
    await Promise.resolve()

    const socket = latestSocket()
    socket.open()
    socket.receiveText({
      type: 'challenge',
      device_id: 'browser-1',
      challenge: 'Y2hhbGxlbmdl',
      context: 'lem-signaling-connect-v1',
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(socket.sentJson().some((m) => m.type === 'auth-response')).toBe(false)
    expect(errors.map((e) => e.message)).toContain('no device key')
    expect(socket.readyState).toBe(3)
  })

  it('applies a remote answer delivered over signaling', async () => {
    await connectThroughSignaling(manager)

    latestSocket().receiveText({
      type: 'answer',
      sender_device_id: 'device-1',
      target_device_id: 'browser-1',
      payload: { sdp: 'remote-answer-sdp', type: 'answer' },
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(FakePeerConnection.instances[0].remoteDescription?.sdp).toBe('remote-answer-sdp')
  })

  // F-COR-4
  it('queues ICE candidates that arrive before the answer and applies them after', async () => {
    await connectThroughSignaling(manager)
    const socket = latestSocket()
    const pc = FakePeerConnection.instances[0]

    // Candidates first - a real RTCPeerConnection throws InvalidStateError here.
    socket.receiveText({
      type: 'ice-candidate',
      sender_device_id: 'device-1',
      target_device_id: 'browser-1',
      payload: { candidate: 'candidate:early-1', sdpMid: '0', sdpMLineIndex: 0 },
    })
    socket.receiveText({
      type: 'ice-candidate',
      sender_device_id: 'device-1',
      target_device_id: 'browser-1',
      payload: { candidate: 'candidate:early-2', sdpMid: '0', sdpMLineIndex: 0 },
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(pc.addedCandidates).toHaveLength(0)

    // ...then the answer, which must flush the queue rather than drop it.
    socket.receiveText({
      type: 'answer',
      sender_device_id: 'device-1',
      target_device_id: 'browser-1',
      payload: { sdp: 'remote-answer-sdp', type: 'answer' },
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(pc.addedCandidates.map((c) => c.candidate)).toEqual([
      'candidate:early-1',
      'candidate:early-2',
    ])
  })

  it('applies ICE candidates directly once the remote description is set', async () => {
    await connectThroughSignaling(manager)
    const socket = latestSocket()
    const pc = FakePeerConnection.instances[0]

    socket.receiveText({
      type: 'answer',
      sender_device_id: 'device-1',
      target_device_id: 'browser-1',
      payload: { sdp: 'remote-answer-sdp', type: 'answer' },
    })
    await vi.advanceTimersByTimeAsync(0)

    socket.receiveText({
      type: 'ice-candidate',
      sender_device_id: 'device-1',
      target_device_id: 'browser-1',
      payload: { candidate: 'candidate:late', sdpMid: '0', sdpMLineIndex: 0 },
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(pc.addedCandidates.map((c) => c.candidate)).toEqual(['candidate:late'])
  })
})

describe('WebRTCConnectionManager failure handling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installFakeWebSocket()
    installFakeWebRTC()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  // F-COR-3
  it('reports a connection failure once the 10s timeout expires', async () => {
    const failures: Error[] = []
    const manager = newManager({ onConnectionFailed: (error) => failures.push(error) })

    await connectThroughSignaling(manager)
    expect(failures).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(10_000)

    expect(failures).toHaveLength(1)
    expect(failures[0].message).toContain('timeout')
    expect(manager.getState()).toBe('failed')

    manager.disconnect()
  })

  // F-COR-3: every failure is reported, even when the state is already `failed`.
  it('reports repeat failures that setState would have de-duplicated', async () => {
    const failures: Error[] = []
    const manager = newManager({ onConnectionFailed: (error) => failures.push(error) })

    await connectThroughSignaling(manager)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(manager.getState()).toBe('failed')

    const pc = FakePeerConnection.instances[0]
    pc.connectionState = 'failed'
    pc.onconnectionstatechange?.()

    expect(failures).toHaveLength(2)

    manager.disconnect()
  })

  // F-COR-2
  it('does not resurrect a connection that was disconnected before the reconnect timer fired', async () => {
    const manager = newManager()
    await connectThroughSignaling(manager)

    const socketsAfterConnect = fakeSockets.length

    // Peer connection fails -> reconnect scheduled 2s out.
    const pc = FakePeerConnection.instances[0]
    pc.connectionState = 'failed'
    pc.onconnectionstatechange?.()

    // User disconnects at +0.5s.
    await vi.advanceTimersByTimeAsync(500)
    manager.disconnect()

    // The old timer fires at +2s and must be a no-op.
    await vi.advanceTimersByTimeAsync(5_000)

    expect(fakeSockets.length).toBe(socketsAfterConnect)
    expect(manager.getState()).toBe('disconnected')
  })

  // F-COR-2
  it('does not leak the previous signaling socket when reconnecting', async () => {
    const manager = newManager()
    await connectThroughSignaling(manager)
    const firstSocket = latestSocket()

    const pc = FakePeerConnection.instances[0]
    pc.connectionState = 'failed'
    pc.onconnectionstatechange?.()

    await vi.advanceTimersByTimeAsync(2_000)

    // A new socket exists and the old one was explicitly closed with its
    // handlers detached, so it cannot drive a second reconnect loop.
    expect(fakeSockets.length).toBeGreaterThan(1)
    expect(firstSocket.closeCalls).toBeGreaterThan(0)
    expect(firstSocket.onclose).toBeNull()
    expect(firstSocket.onmessage).toBeNull()

    manager.disconnect()
  })

  // F-COR-3: stopReconnection() used to poison the manager for the whole session.
  it('re-arms reconnection when connect() is called after stopReconnection()', async () => {
    const manager = newManager()
    await connectThroughSignaling(manager)

    manager.stopReconnection()
    await connectThroughSignaling(manager)

    const socketsBefore = fakeSockets.length
    const pc = FakePeerConnection.instances.at(-1)
    expect(pc).toBeDefined()
    if (!pc) return
    pc.connectionState = 'failed'
    pc.onconnectionstatechange?.()

    await vi.advanceTimersByTimeAsync(2_000)

    expect(fakeSockets.length).toBeGreaterThan(socketsBefore)

    manager.disconnect()
  })

  // F-COR-7
  it('rejects sendConnectRequest without leaving an unsettled timeout behind', async () => {
    const manager = newManager()
    await connectThroughSignaling(manager)

    // Kill the socket so sendSignalingMessage throws from inside the promise.
    latestSocket().readyState = 3

    await expect(manager.sendConnectRequest('relay', 'session-1')).rejects.toThrow(
      'WebSocket not connected'
    )

    manager.disconnect()
  })

  it('resolves sendConnectRequest when the ack arrives', async () => {
    const manager = newManager()
    await connectThroughSignaling(manager)

    const pending = manager.sendConnectRequest('relay', 'session-1')
    latestSocket().receiveText({
      type: 'connect-ack-received',
      from_device_id: 'device-1',
      transport: 'relay',
      relay_session_id: 'session-1',
      status: 'connecting',
    })

    await expect(pending).resolves.toMatchObject({ status: 'connecting' })

    manager.disconnect()
  })

  it('throws when sending on a closed data channel', () => {
    const manager = newManager()
    expect(() => manager.sendData('test')).toThrow('DataChannel not open')
  })
})
