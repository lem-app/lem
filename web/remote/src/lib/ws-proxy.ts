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
 * WebSocket proxy over the tunnel transport (protocol v3).
 *
 * The defect this closes: v2 sent WS_CONNECT and waited forever.
 * `handleConnectionOpened()` existed but nothing called it, there was no ack
 * frame, and the server's own comment said the client "assumes success". So
 * `readyState` stayed CONNECTING, `onopen` never fired, and every `send()`
 * threw - which is why Open WebUI's socket.io and Ollama streaming hung.
 *
 * v3 adds `WS_CONNECT_ACK` / `WS_CONNECT_ERROR` and the state machine around
 * them, including buffering `send()` calls made before the ack: real apps call
 * `send()` synchronously after construction.
 */

import type { Transport } from './proxy-fetch'
import { FrameType, MAX_CHUNK_BYTES } from './http-frame'
import {
  MAX_WS_MESSAGE_BYTES,
  WSOpcode,
  deserializeWSClose,
  deserializeWSConnectAck,
  deserializeWSConnectError,
  deserializeWSData,
  serializeWSClose,
  serializeWSConnect,
  serializeWSData,
  type WSCloseFrame,
  type WSDataFrame,
  type WSOpcodeValue,
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

/** No ack within this window fails the connection with 4003. */
export const WS_CONNECT_TIMEOUT_MS = 10_000

/** How long `close()` waits for the peer's WS_CLOSE before giving up. */
export const WS_CLOSE_TIMEOUT_MS = 5_000

/** Close code used when the tunnel transport is gone. */
const WS_CODE_ABNORMAL = 1006

/** Close code used when no ack arrived in time (spec section 7.2). */
const WS_CODE_CONNECT_TIMEOUT = 4003

/** Close code used when a reassembled message exceeds its cap. */
const WS_CODE_MESSAGE_TOO_LARGE = 4005

interface BufferedSend {
  opcode: WSOpcodeValue
  payload: ArrayBuffer
}

interface PendingMessage {
  opcode: WSOpcodeValue
  parts: Uint8Array[]
  size: number
}

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
  private _requestedProtocols: string[] = []
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
  private maxChunkBytes = MAX_CHUNK_BYTES

  /**
   * Frames queued while the connection is still CONNECTING.
   *
   * Throwing here (what v2 did) breaks every app that calls `send()` in the
   * same turn as the constructor, which is most of them.
   */
  private sendBuffer: BufferedSend[] = []
  private bufferedBytes = 0

  /** Fragments of an inbound message awaiting its FIN. */
  private pendingMessage: PendingMessage | null = null

  private connectTimer: number | null = null
  private closeTimer: number | null = null

  /**
   * Tail of the outbound send chain, or null when nothing is in flight.
   *
   * Blob payloads have to be read asynchronously. Firing `.arrayBuffer().then()`
   * and forgetting about it both floated a rejection and let a later string
   * `send()` overtake an earlier Blob one. Chaining keeps frames in call order.
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

    if (typeof protocols === 'string') {
      this._requestedProtocols = [protocols]
    } else if (Array.isArray(protocols)) {
      this._requestedProtocols = [...protocols]
    }

    // Send WS_CONNECT *after* the current task, so a caller doing
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
    return this.bufferedBytes
  }

  /**
   * Swap the underlying transport (used when falling back to the relay).
   */
  setTransport(transport: Transport): void {
    this.transport = transport
  }

  /**
   * Apply the chunk limit negotiated in HELLO.
   */
  setMaxChunkBytes(maxChunkBytes: number): void {
    this.maxChunkBytes = Math.max(1, Math.min(MAX_CHUNK_BYTES, maxChunkBytes))
  }

  /**
   * Send WS_CONNECT and start the ack timeout.
   */
  private sendConnectFrame(): void {
    try {
      const frame = serializeWSConnect({
        connectionId: this.connectionId,
        url: this._url,
        headers: this._requestedProtocols.length
          ? [['Sec-WebSocket-Protocol', this._requestedProtocols.join(', ')]]
          : [],
      })

      if (!this.transport.isOpen()) {
        this.handleError(new Error('Tunnel transport not open'))
        return
      }

      this.transport.sendData(frame)
      this.connectTimer = window.setTimeout(() => {
        this.connectTimer = null
        console.warn(`[WSProxy] No ack for connection ${this.connectionId}`)
        this.handleClose({
          connectionId: this.connectionId,
          closeCode: WS_CODE_CONNECT_TIMEOUT,
          reason: 'WebSocket handshake timed out',
        })
      }, WS_CONNECT_TIMEOUT_MS)
      console.log(`[WSProxy] Sent WS_CONNECT for connection ${this.connectionId}: ${this._url}`)
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Send data over WebSocket.
   *
   * Buffers while CONNECTING; throws in CLOSING/CLOSED, matching the platform.
   */
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this._readyState === ProxiedWSState.CLOSING || this._readyState === ProxiedWSState.CLOSED) {
      throw new DOMException('WebSocket is already in CLOSING or CLOSED state', 'InvalidStateError')
    }

    if (typeof data === 'string') {
      const payload = new TextEncoder().encode(data)
      this.enqueue(
        WSOpcode.TEXT,
        payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
      )
    } else if (data instanceof Blob) {
      this.enqueueAsync(WSOpcode.BINARY, data.arrayBuffer())
    } else if (ArrayBuffer.isView(data)) {
      // Copy out of the view's window; the buffer may be a SharedArrayBuffer or
      // hold unrelated bytes on either side.
      this.enqueue(
        WSOpcode.BINARY,
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer
      )
    } else {
      this.enqueue(WSOpcode.BINARY, data as ArrayBuffer)
    }
  }

  /**
   * Route a payload that is already in hand.
   */
  private enqueue(opcode: WSOpcodeValue, payload: ArrayBuffer): void {
    if (this._readyState === ProxiedWSState.CONNECTING) {
      this.buffer(opcode, payload)
      return
    }
    if (this.sendQueue === null) {
      this.sendMessage(opcode, payload)
      return
    }
    this.chainSend(opcode, Promise.resolve(payload))
  }

  /** Route a payload that still has to be read (Blob). */
  private enqueueAsync(opcode: WSOpcodeValue, payload: Promise<ArrayBuffer>): void {
    this.chainSend(opcode, payload)
  }

  /**
   * Append to the outbound chain so frames leave in call order.
   */
  private chainSend(opcode: WSOpcodeValue, payload: Promise<ArrayBuffer>): void {
    const previous = this.sendQueue ?? Promise.resolve()
    const next: Promise<void> = previous
      .then(async () => {
        const resolved = await payload
        if (this._readyState === ProxiedWSState.CONNECTING) {
          this.buffer(opcode, resolved)
          return
        }
        this.sendMessage(opcode, resolved)
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
   * Hold a frame until the ack arrives.
   */
  private buffer(opcode: WSOpcodeValue, payload: ArrayBuffer): void {
    if (this.bufferedBytes + payload.byteLength > MAX_WS_MESSAGE_BYTES) {
      this.handleError(new Error('Buffered too much data before the connection opened'))
      return
    }
    this.bufferedBytes += payload.byteLength
    this.sendBuffer.push({ opcode, payload })
  }

  /**
   * Send one message, fragmenting it to the negotiated chunk size.
   */
  private sendMessage(opcode: WSOpcodeValue, payload: ArrayBuffer): void {
    try {
      const bytes = new Uint8Array(payload)
      const limit = this.maxChunkBytes

      if (bytes.byteLength <= limit) {
        this.transport.sendData(
          serializeWSData({
            connectionId: this.connectionId,
            opcode,
            payload: bytes,
            fin: true,
          })
        )
        return
      }

      for (let offset = 0; offset < bytes.byteLength; offset += limit) {
        const slice = bytes.subarray(offset, offset + limit)
        this.transport.sendData(
          serializeWSData({
            connectionId: this.connectionId,
            opcode: offset === 0 ? opcode : WSOpcode.CONTINUATION,
            payload: slice,
            fin: offset + limit >= bytes.byteLength,
          })
        )
      }
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Close WebSocket connection.
   *
   * The close event is *not* synthesised locally any more; it waits for the
   * peer's WS_CLOSE, with a timeout. Firing it immediately told the app the
   * socket was closed while the upstream was still being torn down.
   */
  close(code = 1000, reason = ''): void {
    if (this._readyState === ProxiedWSState.CLOSING || this._readyState === ProxiedWSState.CLOSED) {
      return
    }

    this._readyState = ProxiedWSState.CLOSING
    this.clearConnectTimer()

    try {
      this.transport.sendData(
        serializeWSClose({ connectionId: this.connectionId, closeCode: code, reason })
      )
      console.log(`[WSProxy] Sent WS_CLOSE for connection ${this.connectionId} (code: ${code})`)

      this.closeTimer = window.setTimeout(() => {
        this.closeTimer = null
        this.handleClose({ connectionId: this.connectionId, closeCode: code, reason })
      }, WS_CLOSE_TIMEOUT_MS)
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Handle WS_CONNECT_ACK: this is what reaches readyState OPEN.
   */
  handleConnectAck(protocol: string): void {
    if (this._readyState !== ProxiedWSState.CONNECTING) {
      return
    }

    this.clearConnectTimer()
    this._protocol = protocol
    this._readyState = ProxiedWSState.OPEN

    const event = new Event('open')
    this.onopen?.(event)
    this.dispatchEvent(event)

    // Flush anything the app sent before the socket was open.
    const buffered = this.sendBuffer
    this.sendBuffer = []
    this.bufferedBytes = 0
    buffered.forEach(({ opcode, payload }) => {
      this.sendMessage(opcode, payload)
    })
  }

  /**
   * Handle WS_CONNECT_ERROR: fail fast rather than waiting out the timeout.
   */
  handleConnectError(code: number, reason: string): void {
    this.clearConnectTimer()

    const errorEvent = new Event('error')
    this.onerror?.(errorEvent)
    this.dispatchEvent(errorEvent)

    this.handleClose({ connectionId: this.connectionId, closeCode: code, reason })
  }

  /**
   * Handle incoming WS_DATA frame from the server.
   */
  handleData(frame: WSDataFrame): void {
    if (frame.connectionId !== this.connectionId) {
      console.warn(
        `[WSProxy] Received data for wrong connection: ${frame.connectionId} (expected: ${this.connectionId})`
      )
      return
    }

    const assembled = this.reassemble(frame)
    if (!assembled) return

    const [opcode, payload] = assembled

    let data: string | ArrayBuffer | Blob
    if (opcode === WSOpcode.TEXT) {
      data = new TextDecoder().decode(payload)
    } else if (this._binaryType === 'blob') {
      data = new Blob([payload as BlobPart])
    } else {
      data = payload.buffer.slice(
        payload.byteOffset,
        payload.byteOffset + payload.byteLength
      ) as ArrayBuffer
    }

    const event = new MessageEvent('message', {
      data,
      origin: new URL(this._url).origin,
    })

    this.onmessage?.(event)
    this.dispatchEvent(event)
  }

  /**
   * Reassemble a possibly-fragmented inbound message.
   */
  private reassemble(frame: WSDataFrame): [WSOpcodeValue, Uint8Array] | null {
    if (frame.opcode === WSOpcode.CONTINUATION) {
      const pending = this.pendingMessage
      if (!pending) {
        console.warn(`[WSProxy] CONTINUATION with no message in progress`)
        return null
      }
      if (pending.size + frame.payload.byteLength > MAX_WS_MESSAGE_BYTES) {
        this.pendingMessage = null
        this.handleClose({
          connectionId: this.connectionId,
          closeCode: WS_CODE_MESSAGE_TOO_LARGE,
          reason: 'Message too large',
        })
        return null
      }
      pending.parts.push(frame.payload)
      pending.size += frame.payload.byteLength

      if (!frame.fin) return null

      this.pendingMessage = null
      const joined = new Uint8Array(pending.size)
      let offset = 0
      pending.parts.forEach((part) => {
        joined.set(part, offset)
        offset += part.byteLength
      })
      return [pending.opcode, joined]
    }

    if (!frame.fin) {
      this.pendingMessage = {
        opcode: frame.opcode,
        parts: [frame.payload],
        size: frame.payload.byteLength,
      }
      return null
    }

    return [frame.opcode, frame.payload]
  }

  /**
   * Handle incoming WS_CLOSE frame from the server.
   */
  handleClose(frame: WSCloseFrame): void {
    if (frame.connectionId !== this.connectionId) {
      console.warn(
        `[WSProxy] Received close for wrong connection: ${frame.connectionId} (expected: ${this.connectionId})`
      )
      return
    }

    if (this._readyState === ProxiedWSState.CLOSED) {
      return
    }

    this.clearConnectTimer()
    this.clearCloseTimer()
    this._readyState = ProxiedWSState.CLOSED
    this.sendBuffer = []
    this.bufferedBytes = 0
    this.pendingMessage = null

    const event = new CloseEvent('close', {
      code: frame.closeCode,
      reason: frame.reason,
      wasClean: frame.closeCode === 1000,
    })

    this.onclose?.(event)
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

    if (this._readyState !== ProxiedWSState.CLOSED) {
      this.handleClose({
        connectionId: this.connectionId,
        closeCode: WS_CODE_ABNORMAL,
        reason: error.message,
      })
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
  }

  private clearCloseTimer(): void {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
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
 * Manages multiple proxied WebSocket connections and routes frames.
 */
export class WSProxyManager {
  private transport: Transport
  private connections = new Map<number, ProxiedWebSocket>()
  private nextConnectionId = 1
  private maxChunkBytes = MAX_CHUNK_BYTES

  constructor(transport: Transport) {
    this.transport = transport
  }

  /**
   * Point this manager (and every live connection) at a different transport.
   */
  updateTransport(transport: Transport): void {
    this.transport = transport
    this.connections.forEach((connection) => {
      connection.setTransport(transport)
    })
    console.log('[WSProxyManager] Updated transport')
  }

  /**
   * Apply the chunk limit negotiated in HELLO.
   */
  setNegotiatedLimits(peerMaxChunkBytes: number): void {
    this.maxChunkBytes = Math.max(1, Math.min(MAX_CHUNK_BYTES, peerMaxChunkBytes))
    this.connections.forEach((connection) => {
      connection.setMaxChunkBytes(this.maxChunkBytes)
    })
  }

  /**
   * Create a new proxied WebSocket connection.
   */
  createConnection(url: string, protocols?: string | string[]): ProxiedWebSocket {
    const connectionId = this.nextConnectionId
    this.nextConnectionId = this.nextConnectionId >= 0xffffffff ? 1 : this.nextConnectionId + 1

    const ws = new ProxiedWebSocket(url, protocols, this.transport, connectionId)
    ws.setMaxChunkBytes(this.maxChunkBytes)
    this.connections.set(connectionId, ws)

    console.log(`[WSProxyManager] Created connection ${connectionId} for ${url}`)

    return ws
  }

  /**
   * Route one inbound frame.
   *
   * Returns true when the frame belonged to this manager.
   */
  handleFrame(buffer: ArrayBuffer): boolean {
    const view = new Uint8Array(buffer)
    if (view.byteLength < 1) return false

    switch (view[0]) {
      case FrameType.WS_DATA:
        this.handleDataFrame(buffer)
        return true
      case FrameType.WS_CLOSE:
        this.handleCloseFrame(buffer)
        return true
      case FrameType.WS_CONNECT_ACK:
        this.handleConnectAckFrame(buffer)
        return true
      case FrameType.WS_CONNECT_ERROR:
        this.handleConnectErrorFrame(buffer)
        return true
      default:
        return false
    }
  }

  /**
   * Handle incoming WS_DATA frame.
   */
  handleDataFrame(buffer: ArrayBuffer): void {
    try {
      const frame = deserializeWSData(buffer, this.maxChunkBytes)
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
   * Handle incoming WS_CONNECT_ACK frame - the frame v2 never had.
   */
  handleConnectAckFrame(buffer: ArrayBuffer): void {
    try {
      const frame = deserializeWSConnectAck(buffer)
      const connection = this.connections.get(frame.connectionId)

      if (connection) {
        connection.handleConnectAck(frame.protocol)
      } else {
        console.warn(`[WSProxyManager] Ack for unknown connection: ${frame.connectionId}`)
      }
    } catch (error) {
      console.error('[WSProxyManager] Error handling WS_CONNECT_ACK frame:', error)
    }
  }

  /**
   * Handle incoming WS_CONNECT_ERROR frame.
   */
  handleConnectErrorFrame(buffer: ArrayBuffer): void {
    try {
      const frame = deserializeWSConnectError(buffer)
      const connection = this.connections.get(frame.connectionId)

      if (connection) {
        connection.handleConnectError(frame.errorCode, frame.reason)
        this.connections.delete(frame.connectionId)
      } else {
        console.warn(`[WSProxyManager] Connect error for unknown connection: ${frame.connectionId}`)
      }
    } catch (error) {
      console.error('[WSProxyManager] Error handling WS_CONNECT_ERROR frame:', error)
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
