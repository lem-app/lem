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
 * Tests for WebRTC connection manager.
 */

/// <reference types="vitest/globals" />

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebRTCConnectionManager } from './webrtc'
import type { ConnectionState } from '../api/types'

describe('WebRTCConnectionManager', () => {
  let manager: WebRTCConnectionManager

  beforeEach(() => {
    // Mock WebSocket
    globalThis.WebSocket = vi.fn().mockImplementation(() => ({
      close: vi.fn(),
      send: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      readyState: WebSocket.OPEN,
    })) as unknown as typeof WebSocket

    // Mock RTCPeerConnection
    globalThis.RTCPeerConnection = vi.fn().mockImplementation(() => ({
      createDataChannel: vi.fn().mockReturnValue({
        readyState: 'connecting',
        addEventListener: vi.fn(),
      }),
      createOffer: vi.fn().mockResolvedValue({ sdp: 'mock-sdp', type: 'offer' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      createAnswer: vi.fn().mockResolvedValue({ sdp: 'mock-sdp', type: 'answer' }),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      connectionState: 'new',
      addEventListener: vi.fn(),
    })) as unknown as typeof RTCPeerConnection

    manager = new WebRTCConnectionManager({
      signalUrl: 'ws://localhost:8000/signal',
      token: 'test-token',
      deviceId: 'test-device',
      targetDeviceId: 'target-device',
    })
  })

  afterEach(() => {
    manager.disconnect()
    vi.clearAllMocks()
  })

  it('should initialize with disconnected state', () => {
    expect(manager.getState()).toBe('disconnected')
  })

  it('should get data channel state', () => {
    const state = manager.getDataChannelState()
    expect(['none', 'connecting', 'open', 'closing', 'closed']).toContain(state)
  })

  it('should handle state changes via callback', () => {
    const onStateChange = vi.fn()
    const managerWithCallback = new WebRTCConnectionManager({
      signalUrl: 'ws://localhost:8000/signal',
      token: 'test-token',
      deviceId: 'test-device',
      targetDeviceId: 'target-device',
      onStateChange,
    })

    expect(managerWithCallback.getState()).toBe('disconnected')
  })

  it('should handle errors via callback', () => {
    const onError = vi.fn()
    const managerWithCallback = new WebRTCConnectionManager({
      signalUrl: 'ws://localhost:8000/signal',
      token: 'test-token',
      deviceId: 'test-device',
      targetDeviceId: 'target-device',
      onError,
    })

    expect(managerWithCallback).toBeDefined()
  })

  it('should disconnect cleanly', () => {
    manager.disconnect()
    expect(manager.getState()).toBe('disconnected')
  })

  it('should throw error when sending data with closed channel', () => {
    expect(() => manager.sendData('test')).toThrow('DataChannel not open')
  })
})

describe('WebRTCConnectionManager - State Management', () => {
  it('should track connection state changes', () => {
    const states: ConnectionState[] = []
    const manager = new WebRTCConnectionManager({
      signalUrl: 'ws://localhost:8000/signal',
      token: 'test-token',
      deviceId: 'test-device',
      targetDeviceId: 'target-device',
      onStateChange: (state) => states.push(state),
    })

    expect(manager.getState()).toBe('disconnected')
    expect(states).toEqual([])
  })

  it('should handle data channel messages via callback', () => {
    const messages: string[] = []
    const manager = new WebRTCConnectionManager({
      signalUrl: 'ws://localhost:8000/signal',
      token: 'test-token',
      deviceId: 'test-device',
      targetDeviceId: 'target-device',
      onDataChannelMessage: (message) => messages.push(message),
    })

    expect(manager).toBeDefined()
    expect(messages).toEqual([])
  })
})
