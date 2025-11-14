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
 * WebSocket proxy over WebRTC DataChannel.
 *
 * Provides a WebSocket-like API that proxies connections through the
 * DataChannel to the local server.
 */

import type { WebRTCConnectionManager } from './webrtc'
import {
  serializeWSConnect,
  serializeWSData,
  serializeWSClose,
  deserializeWSData,
  deserializeWSClose,
  WSOpcode,
  type WSDataFrame,
  type WSCloseFrame,
} from './ws-frame'

/**
 * WebSocket connection state.
 */
export enum ProxiedWSState {
  CONNECTING = 0,
  OPEN = 1,
  CLOSING = 2,
  CLOSED = 3,
}

/**
 * Proxied WebSocket connection.
 *
 * Mimics the WebSocket API but tunnels over DataChannel.
 */
export class ProxiedWebSocket implements EventTarget {
  // WebSocket API compatibility
  public readonly CONNECTING = ProxiedWSState.CONNECTING
  public readonly OPEN = ProxiedWSState.OPEN
  public readonly CLOSING = ProxiedWSState.CLOSING
  public readonly CLOSED = ProxiedWSState.CLOSED

  // State
  private connectionId: number
  private _readyState: ProxiedWSState = ProxiedWSState.CONNECTING
  private _url: string
  private _protocol: string = ''
  private _extensions: string = ''
  private _binaryType: BinaryType = 'blob'

  // Event handlers (WebSocket API)
  public onopen: ((ev: Event) => void) | null = null
  public onmessage: ((ev: MessageEvent) => void) | null = null
  public onerror: ((ev: Event) => void) | null = null
  public onclose: ((ev: CloseEvent) => void) | null = null

  // EventTarget implementation
  private eventListeners: Map<string, Set<EventListenerOrEventListenerObject>> = new Map()

  // WebRTC connection
  private webrtc: WebRTCConnectionManager

  constructor(
    url: string,
    protocols: string | string[] | undefined,
    webrtc: WebRTCConnectionManager,
    connectionId: number
  ) {
    this._url = url
    this.webrtc = webrtc
    this.connectionId = connectionId

    // Normalize protocols
    if (typeof protocols === 'string') {
      this._protocol = protocols
    } else if (Array.isArray(protocols) && protocols.length > 0) {
      this._protocol = protocols[0] // Use first protocol
    }

    // Send WS_CONNECT frame
    this.sendConnectFrame()
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

      if (this.webrtc.getDataChannelState() !== 'open') {
        this.handleError(new Error('DataChannel not open'))
        return
      }

      this.webrtc.sendData(frame)
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

    // Convert data to ArrayBuffer
    if (typeof data === 'string') {
      // Text frame
      const encoder = new TextEncoder()
      const payload = encoder.encode(data)
      this.sendDataFrame(WSOpcode.TEXT, payload.buffer)
    } else if (data instanceof Blob) {
      // Read Blob as ArrayBuffer
      data.arrayBuffer().then((buffer) => {
        this.sendDataFrame(WSOpcode.BINARY, buffer)
      })
    } else if (data instanceof ArrayBuffer) {
      // Binary frame
      this.sendDataFrame(WSOpcode.BINARY, data)
    } else {
      // ArrayBufferView (TypedArray, DataView)
      const view = data as ArrayBufferView
      this.sendDataFrame(WSOpcode.BINARY, view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
    }
  }

  /**
   * Send WS_DATA frame.
   */
  private sendDataFrame(opcode: number, payload: ArrayBuffer): void {
    try {
      const frame = serializeWSData({
        connectionId: this.connectionId,
        opcode,
        payload,
      })

      this.webrtc.sendData(frame)
      console.log(`[WSProxy] Sent WS_DATA for connection ${this.connectionId} (opcode: ${opcode})`)
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Close WebSocket connection.
   */
  close(code: number = 1000, reason: string = ''): void {
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

      this.webrtc.sendData(frame)
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
      console.warn(`[WSProxy] Received data for wrong connection: ${frame.connectionId} (expected: ${this.connectionId})`)
      return
    }

    // Dispatch message event
    let data: string | ArrayBuffer | Blob

    if (frame.opcode === WSOpcode.TEXT) {
      // Text message
      const decoder = new TextDecoder()
      data = decoder.decode(frame.payload)
    } else {
      // Binary message
      if (this._binaryType === 'blob') {
        data = new Blob([frame.payload])
      } else {
        data = frame.payload
      }
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
      console.warn(`[WSProxy] Received close for wrong connection: ${frame.connectionId} (expected: ${this.connectionId})`)
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

    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, new Set())
    }

    this.eventListeners.get(type)!.add(listener)
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | EventListenerOptions
  ): void {
    if (!listener) return

    const listeners = this.eventListeners.get(type)
    if (listeners) {
      listeners.delete(listener)
    }
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
  private webrtc: WebRTCConnectionManager
  private connections: Map<number, ProxiedWebSocket> = new Map()
  private nextConnectionId = 1

  constructor(webrtc: WebRTCConnectionManager) {
    this.webrtc = webrtc
  }

  /**
   * Create a new proxied WebSocket connection.
   */
  createConnection(url: string, protocols?: string | string[]): ProxiedWebSocket {
    const connectionId = this.nextConnectionId++
    const ws = new ProxiedWebSocket(url, protocols, this.webrtc, connectionId)
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
        console.warn(`[WSProxyManager] Received close for unknown connection: ${frame.connectionId}`)
      }
    } catch (error) {
      console.error('[WSProxyManager] Error handling WS_CLOSE frame:', error)
    }
  }

  /**
   * Handle connection opened (WS_CONNECT response - currently auto-opens).
   */
  handleConnectionOpened(connectionId: number): void {
    const connection = this.connections.get(connectionId)
    if (connection) {
      connection.handleOpen()
    }
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
