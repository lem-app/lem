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
 * Test doubles for the tunnel transports.
 *
 * These deliberately expose the same `onopen` / `onmessage` / `onicecandidate`
 * *properties* the implementation assigns to. The previous mocks only provided
 * `addEventListener`, which the implementation never calls, so no test could
 * drive a single line of behaviour.
 */

import type { DeviceKeyStore, StoredIdentity } from '../api/device-key'

/**
 * An in-memory device key store.
 *
 * jsdom has no IndexedDB, and the production store is a thin adapter around
 * one. This keeps the protocol logic - key generation, payload construction,
 * signing - fully testable against real WebCrypto keys.
 *
 * @returns A store that keeps one identity in memory.
 */
export function memoryKeyStore(): DeviceKeyStore {
  let saved: StoredIdentity | null = null
  return {
    load(): Promise<StoredIdentity | null> {
      return Promise.resolve(saved)
    },
    save(identity: StoredIdentity): Promise<void> {
      saved = identity
      return Promise.resolve()
    },
  }
}

/** Sockets created since the last `resetFakeWebSockets()`. */
export const fakeSockets: FakeWebSocket[] = []

export class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = FakeWebSocket.CONNECTING
  readonly OPEN = FakeWebSocket.OPEN
  readonly CLOSING = FakeWebSocket.CLOSING
  readonly CLOSED = FakeWebSocket.CLOSED

  readyState: number = FakeWebSocket.CONNECTING
  binaryType: BinaryType = 'blob'

  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null

  /** Everything passed to `send()`, in order. */
  readonly sent: (string | ArrayBuffer)[] = []
  closeCalls = 0

  readonly url: string

  constructor(url: string) {
    this.url = url
    fakeSockets.push(this)
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }

  close(): void {
    this.closeCalls += 1
    this.readyState = FakeWebSocket.CLOSED
  }

  addEventListener(): void {
    // The implementation uses on* properties; present only for API parity.
  }

  removeEventListener(): void {
    // See addEventListener.
  }

  // --- test drivers -------------------------------------------------------

  /** Simulate the socket opening. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  /** Deliver a text frame. */
  receiveText(payload: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }))
  }

  /** Deliver a binary frame. */
  receiveBinary(buffer: ArrayBuffer): void {
    this.onmessage?.(new MessageEvent('message', { data: buffer }))
  }

  /** Simulate the peer closing the socket. */
  serverClose(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close', { code, reason }))
  }

  /** Parse the JSON messages this socket was asked to send. */
  sentJson(): Record<string, unknown>[] {
    return this.sent
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
  }
}

export function installFakeWebSocket(): void {
  fakeSockets.length = 0
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
}

export function resetFakeWebSockets(): void {
  fakeSockets.length = 0
}

/** The most recently constructed fake socket. */
export function latestSocket(): FakeWebSocket {
  const socket = fakeSockets.at(-1)
  if (!socket) throw new Error('No FakeWebSocket has been created')
  return socket
}

/**
 * Minimal RTCPeerConnection stand-in.
 *
 * `remoteDescription` starts null so early-ICE-candidate queueing can be
 * exercised, and `addIceCandidate` rejects while it is null, exactly like a real
 * peer connection.
 */
export class FakePeerConnection {
  static instances: FakePeerConnection[] = []

  onconnectionstatechange: (() => void) | null = null
  oniceconnectionstatechange: (() => void) | null = null
  onicecandidate: ((ev: RTCPeerConnectionIceEvent) => void) | null = null
  ondatachannel: ((ev: RTCDataChannelEvent) => void) | null = null

  connectionState: RTCPeerConnectionState = 'new'
  iceConnectionState: RTCIceConnectionState = 'new'
  remoteDescription: RTCSessionDescription | null = null

  readonly addedCandidates: RTCIceCandidate[] = []
  closed = false

  constructor() {
    FakePeerConnection.instances.push(this)
  }

  createDataChannel(label: string): FakeDataChannel {
    return new FakeDataChannel(label)
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ sdp: 'fake-offer-sdp', type: 'offer' })
  }

  createAnswer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ sdp: 'fake-answer-sdp', type: 'answer' })
  }

  setLocalDescription(): Promise<void> {
    return Promise.resolve()
  }

  setRemoteDescription(description: RTCSessionDescription): Promise<void> {
    this.remoteDescription = description
    return Promise.resolve()
  }

  addIceCandidate(candidate: RTCIceCandidate): Promise<void> {
    if (this.remoteDescription === null) {
      return Promise.reject(new Error('InvalidStateError: The remote description was null'))
    }
    this.addedCandidates.push(candidate)
    return Promise.resolve()
  }

  close(): void {
    this.closed = true
  }
}

export class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting'
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  readonly sent: (string | ArrayBuffer)[] = []

  readonly label: string

  constructor(label: string) {
    this.label = label
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 'closed'
  }
}

export function installFakeWebRTC(): void {
  FakePeerConnection.instances = []
  globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection

  globalThis.RTCSessionDescription = class {
    sdp: string
    type: RTCSdpType
    constructor(init: RTCSessionDescriptionInit) {
      this.sdp = init.sdp ?? ''
      this.type = init.type
    }
  } as unknown as typeof RTCSessionDescription

  globalThis.RTCIceCandidate = class {
    candidate: string
    sdpMid: string | null
    sdpMLineIndex: number | null
    constructor(init: RTCIceCandidateInit) {
      this.candidate = init.candidate ?? ''
      this.sdpMid = init.sdpMid ?? null
      this.sdpMLineIndex = init.sdpMLineIndex ?? null
    }
  } as unknown as typeof RTCIceCandidate
}
