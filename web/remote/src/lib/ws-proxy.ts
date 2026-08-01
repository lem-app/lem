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
 * WebSocket proxy over the tunnel transport.
 *
 * Provides a WebSocket-like API that proxies connections through the
 * active transport (WebRTC DataChannel or relay WebSocket) to the local server.
 */

import type { Transport } from './proxy-fetch'
import {
  serializeWSConnect,
  serializeWSData,
  serializeWSClose,
  deserializeWSData,
  deserializeWSClose,
  WSOpcode,
  type WSOpcodeValue,
  type WSDataFrame,
  type WSCloseFrame,
} from './ws-frame'

/**
 * WebSocket connection state.
 */
export const ProxiedWSState = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const

export type ProxiedWSStateValue = (typeof ProxiedWSState)[keyof typeof ProxiedWSState]

/**
 * Proxied WebSocket connection.
 *
 * Mimics the WebSocket API but tunnels over the active transport.
 */
export class ProxiedWebSocket implements EventTarget {
  // WebSocket API compatibility
  public readonly CONNECTING = ProxiedWSState.CONNECTING
  public readonly OPEN = ProxiedWSState.OPEN
  public readonly CLOSING = ProxiedWSState.CLOSING
  public readonly CLOSED = ProxiedWSState.CLOSED

  // State
  private connectionId: number
  private _readyState: ProxiedWSStateValue = ProxiedWSState.CONNECTING
  private _url: string
  private _protocol = ''
  private _extensions = ''
  private _binaryType: BinaryType = 'blob'

  // Event handlers (WebSocket API)
  public onopen: ((ev: Event) => void) | null = null
  public onmessage: ((ev: MessageEvent) => void) | null = null
  public onerror: ((ev: Event) => void) | null = null
  public onclose: ((ev: CloseEvent) => void) | null = null

  // EventTarget implementation
  private eventListeners = new Map<string, Set<EventListenerOrEventListenerObject>>()

  // Tunnel transport
  private transport: Transport

  /**
   * Tail of the outbound send chain, or null when nothing is in flight.
   *
   * Blob payloads have to be read asynchronously. Firing `.arrayBuffer().then()`
   * and forgetting about it (the previous behaviour) both floated a rejection
   * and let a later string `send()` overtake an earlier Blob one. Chaining keeps
   * frames in call order; the chain is skipped entirely for the common case
   * where nothing is pending and the payload is already an ArrayBuffer.
   */
  private sendQueue: Promise<void> | null = null

  constructor(
    url: string,
    protocols: string | string[] | undefined,
    transport: Transport,
    connectionId: number
  ) {
    this._url = url
    this.transport = transport
    this.connectionId = connectionId

    // Normalize protocols
    if (typeof protocols === 'string') {
      this._protocol = protocols
    } else if (Array.isArray(protocols) && protocols.length > 0) {
      this._protocol = protocols[0] // Use first protocol
    }

    // Send WS_CONNECT frame *after* the current task, so a caller doing
    //   const ws = new WebSocket(url); ws.onerror = handler
    // still sees a synchronous failure. Dispatching from the constructor meant
    // the handler was assigned too late to ever fire - the real WebSocket never
    // does that.
    queueMicrotask(() => {
      this.sendConnectFrame()
    })
  }

  // WebSocket API properties
  get readyState(): number {
    return this._readyState
  }

  get url(): string {
    return this._url
  }

  get protocol(): string {
    return this._protocol
  }

  get extensions(): string {
    return this._extensions
  }

  get binaryType(): BinaryType {
    return this._binaryType
  }

  set binaryType(value: BinaryType) {
    this._binaryType = value
  }

  get bufferedAmount(): number {
    // Not implemented (would require tracking queued messages)
    return 0
  }

  /**
   * Swap the underlying transport (used when falling back to the relay).
   */
  setTransport(transport: Transport): void {
    this.transport = transport
  }

  /**
   * Send WS_CONNECT frame to establish connection.
   */
  private sendConnectFrame(): void {
    try {
      const frame = serializeWSConnect({
        connectionId: this.connectionId,
        url: this._url,
        headers: {
          // Add any necessary headers
          'Sec-WebSocket-Protocol': this._protocol,
        },
      })

      if (!this.transport.isOpen()) {
        this.handleError(new Error('Tunnel transport not open'))
        return
      }

      this.transport.sendData(frame)
      console.log(`[WSProxy] Sent WS_CONNECT for connection ${this.connectionId}: ${this._url}`)
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Send data over WebSocket.
   */
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this._readyState !== ProxiedWSState.OPEN) {
      throw new Error('WebSocket is not open')
    }

    if (typeof data === 'string') {
      const payload = new TextEncoder().encode(data)
      this.sendSync(
        WSOpcode.TEXT,
        payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
      )
    } else if (data instanceof Blob) {
      this.sendAsync(WSOpcode.BINARY, data.arrayBuffer())
    } else if (ArrayBuffer.isView(data)) {
      // Copy out of the view's window; the buffer may be a SharedArrayBuffer or
      // hold unrelated bytes on either side.
      this.sendSync(
        WSOpcode.BINARY,
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer
      )
    } else {
      this.sendSync(WSOpcode.BINARY, data as ArrayBuffer)
    }
  }

  /**
   * Send a payload that is already in hand. Goes out immediately unless an
   * async payload is still queued ahead of it.
   */
  private sendSync(opcode: WSOpcodeValue, payload: ArrayBuffer): void {
    if (this.sendQueue === null) {
      this.sendDataFrame(opcode, payload)
      return
    }
    this.chainSend(opcode, Promise.resolve(payload))
  }

  /** Send a payload that still has to be read (Blob). */
  private sendAsync(opcode: WSOpcodeValue, payload: Promise<ArrayBuffer>): void {
    this.chainSend(opcode, payload)
  }

  /**
   * Append to the outbound chain so frames leave in call order.
   */
  private chainSend(opcode: WSOpcodeValue, payload: Promise<ArrayBuffer>): void {
    const previous = this.sendQueue ?? Promise.resolve()
    const next: Promise<void> = previous
      .then(async () => {
        this.sendDataFrame(opcode, await payload)
      })
      .catch((error: unknown) => {
        this.handleError(error instanceof Error ? error : new Error(String(error)))
      })
      .then(() => {
        if (this.sendQueue === next) {
          this.sendQueue = null
        }
      })

    this.sendQueue = next
  }

  /**
   * Send WS_DATA frame.
   */
  private sendDataFrame(opcode: WSOpcodeValue, payload: ArrayBuffer): void {
    try {
      const frame = serializeWSData({
        connectionId: this.connectionId,
        opcode,
        payload,
      })

      this.transport.sendData(frame)
      console.log(`[WSProxy] Sent WS_DATA for connection ${this.connectionId} (opcode: ${opcode})`)
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Close WebSocket connection.
   */
  close(code = 1000, reason = ''): void {
    if (this._readyState === ProxiedWSState.CLOSING || this._readyState === ProxiedWSState.CLOSED) {
      return
    }

    this._readyState = ProxiedWSState.CLOSING

    try {
      const frame = serializeWSClose({
        connectionId: this.connectionId,
        closeCode: code,
        reason,
      })

      this.transport.sendData(frame)
      console.log(`[WSProxy] Sent WS_CLOSE for connection ${this.connectionId} (code: ${code})`)

      // Transition to CLOSED immediately (server will acknowledge)
      this.handleClose({ connectionId: this.connectionId, closeCode: code, reason })
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Handle incoming WS_DATA frame from server.
   */
  handleData(frame: WSDataFrame): void {
    if (frame.connectionId !== this.connectionId) {
      console.warn(
        `[WSProxy] Received data for wrong connection: ${frame.connectionId} (expected: ${this.connectionId})`
      )
      return
    }

    // Dispatch message event
    let data: string | ArrayBuffer | Blob

    if (frame.opcode === WSOpcode.TEXT) {
      // Text message
      data = new TextDecoder().decode(frame.payload)
    } else if (this._binaryType === 'blob') {
      data = new Blob([frame.payload])
    } else {
      data = frame.payload
    }

    const event = new MessageEvent('message', {
      data,
      origin: new URL(this._url).origin,
    })

    this.onmessage?.(event)
    this.dispatchEvent(event)
  }

  /**
   * Handle incoming WS_CLOSE frame from server.
   */
  handleClose(frame: WSCloseFrame): void {
    if (frame.connectionId !== this.connectionId) {
      console.warn(
        `[WSProxy] Received close for wrong connection: ${frame.connectionId} (expected: ${this.connectionId})`
      )
      return
    }

    this._readyState = ProxiedWSState.CLOSED

    const event = new CloseEvent('close', {
      code: frame.closeCode,
      reason: frame.reason,
      wasClean: frame.closeCode === 1000,
    })

    this.onclose?.(event)
    this.dispatchEvent(event)
  }

  /**
   * Handle connection opened (called by WSProxyManager).
   */
  handleOpen(): void {
    this._readyState = ProxiedWSState.OPEN

    const event = new Event('open')
    this.onopen?.(event)
    this.dispatchEvent(event)
  }

  /**
   * Handle error.
   */
  private handleError(error: Error): void {
    console.error(`[WSProxy] Error on connection ${this.connectionId}:`, error)

    const event = new Event('error')
    this.onerror?.(event)
    this.dispatchEvent(event)

    // Close connection on error
    if (this._readyState !== ProxiedWSState.CLOSED) {
      this.handleClose({
        connectionId: this.connectionId,
        closeCode: 1006, // Abnormal closure
        reason: error.message,
      })
    }
  }

  // EventTarget implementation
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | AddEventListenerOptions
  ): void {
    if (!listener) return

    let listeners = this.eventListeners.get(type)
    if (!listeners) {
      listeners = new Set()
      this.eventListeners.set(type, listeners)
    }

    listeners.add(listener)
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | EventListenerOptions
  ): void {
    if (!listener) return

    this.eventListeners.get(type)?.delete(listener)
  }

  dispatchEvent(event: Event): boolean {
    const listeners = this.eventListeners.get(event.type)
    if (listeners) {
      listeners.forEach((listener) => {
        if (typeof listener === 'function') {
          listener(event)
        } else {
          listener.handleEvent(event)
        }
      })
    }
    return true
  }
}

/**
 * WebSocket proxy manager.
 *
 * Manages multiple proxied WebSocket connections and routes messages.
 */
export class WSProxyManager {
  private transport: Transport
  private connections = new Map<number, ProxiedWebSocket>()
  private nextConnectionId = 1

  constructor(transport: Transport) {
    this.transport = transport
  }

  /**
   * Point this manager (and every live connection) at a different transport.
   *
   * Used when the WebRTC leg fails and we switch to the relay. This used to
   * force a `RelayClient` into a `WebRTCConnectionManager`-typed field and write
   * another object's private property behind two `@ts-expect-error`s; the
   * `Transport` interface exists precisely so it doesn't have to.
   */
  updateTransport(transport: Transport): void {
    this.transport = transport
    this.connections.forEach((connection) => {
      connection.setTransport(transport)
    })
    console.log('[WSProxyManager] Updated transport')
  }

  /**
   * Create a new proxied WebSocket connection.
   */
  createConnection(url: string, protocols?: string | string[]): ProxiedWebSocket {
    const connectionId = this.nextConnectionId++
    const ws = new ProxiedWebSocket(url, protocols, this.transport, connectionId)
    this.connections.set(connectionId, ws)

    console.log(`[WSProxyManager] Created connection ${connectionId} for ${url}`)

    return ws
  }

  /**
   * Handle incoming WS_DATA frame.
   */
  handleDataFrame(buffer: ArrayBuffer): void {
    try {
      const frame = deserializeWSData(buffer)
      const connection = this.connections.get(frame.connectionId)

      if (connection) {
        connection.handleData(frame)
      } else {
        console.warn(`[WSProxyManager] Received data for unknown connection: ${frame.connectionId}`)
      }
    } catch (error) {
      console.error('[WSProxyManager] Error handling WS_DATA frame:', error)
    }
  }

  /**
   * Handle incoming WS_CLOSE frame.
   */
  handleCloseFrame(buffer: ArrayBuffer): void {
    try {
      const frame = deserializeWSClose(buffer)
      const connection = this.connections.get(frame.connectionId)

      if (connection) {
        connection.handleClose(frame)
        this.connections.delete(frame.connectionId)
      } else {
        console.warn(
          `[WSProxyManager] Received close for unknown connection: ${frame.connectionId}`
        )
      }
    } catch (error) {
      console.error('[WSProxyManager] Error handling WS_CLOSE frame:', error)
    }
  }

  /**
   * Handle connection opened (WS_CONNECT response - currently auto-opens).
   */
  handleConnectionOpened(connectionId: number): void {
    this.connections.get(connectionId)?.handleOpen()
  }

  /**
   * Close all connections.
   */
  closeAll(): void {
    this.connections.forEach((connection) => {
      connection.close(1001, 'Going away')
    })
    this.connections.clear()
  }
}
