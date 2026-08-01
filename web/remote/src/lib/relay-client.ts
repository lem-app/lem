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
 * WebSocket relay client for browser HTTP tunneling.
 *
 * Provides automatic fallback when WebRTC P2P/TURN connections fail.
 * Uses the same HTTP framing protocol as the DataChannel implementation.
 *
 * ## Authentication handshake
 *
 * `cloud/relay/app/api/relay.py` accepts the socket, then waits for a first
 * text message `{"type": "auth", "token": "..."}`. On success it sends
 * **nothing** and simply starts forwarding; on failure it sends
 * `{"type": "error", "message": "..."}` and closes with 1008
 * (`WS_1008_POLICY_VIOLATION`).
 *
 * There is therefore no positive acknowledgement to wait for today. Reporting
 * `connected` straight out of `onopen` (what this client used to do) painted
 * the UI green for an expired JWT and then looped reconnecting forever with no
 * visible error. Until the relay grows an explicit ack, this client:
 *
 * 1. stays in `connecting` after sending auth,
 * 2. treats an explicit `{"type": "error"}` control frame or a 1008 close as a
 *    **permanent** auth failure - surfaced to the caller, reconnection stopped,
 * 3. treats an explicit `{"type": "connected"}` / `{"type": "auth-ok"}` control
 *    frame, or the first binary frame, as proof the tunnel is live (so we adopt
 *    a real ack automatically once the server sends one),
 * 4. otherwise reports `connected` after {@link AUTH_GRACE_MS} of silence,
 *    which is the honest best available signal.
 *
 * Reconnection is also bounded: an endless invisible retry loop is worse than a
 * visible error.
 */

import type { ConnectionState } from '../api/types'

/**
 * Raised when the relay rejects our credentials. Reconnecting will not help.
 */
export class RelayAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayAuthError'
  }
}

/**
 * How long to wait after sending auth before assuming the relay accepted it.
 * The relay's own auth read has a 10s timeout, but rejection is immediate, so a
 * short window is enough to catch it.
 */
const AUTH_GRACE_MS = 750

const INITIAL_RECONNECT_DELAY_MS = 2000
const MAX_RECONNECT_DELAY_MS = 60000
const MAX_RECONNECT_ATTEMPTS = 5

/** WebSocket close code the relay uses to reject bad credentials. */
const WS_POLICY_VIOLATION = 1008

/**
 * Relay client configuration.
 */
export interface RelayClientConfig {
  relayUrl: string
  sessionId: string
  token: string
  onStateChange?: (state: ConnectionState) => void
  onMessage?: (message: ArrayBuffer) => void
  onError?: (error: Error) => void
}

interface RelayControlMessage {
  type?: unknown
  message?: unknown
}

/**
 * WebSocket relay client for HTTP tunneling.
 *
 * Connects to relay server and forwards HTTP frames over WebSocket
 * when WebRTC P2P/TURN connections are unavailable.
 */
export class RelayClient {
  private relayUrl: string
  private sessionId: string
  private token: string

  private ws: WebSocket | null = null
  private state: ConnectionState = 'disconnected'

  // Callbacks
  private onStateChange?: (state: ConnectionState) => void
  private onMessage?: (message: ArrayBuffer) => void
  private onError?: (error: Error) => void

  // Reconnection
  private shouldReconnect = true
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS
  private reconnectTimer: number | null = null
  private reconnectAttempts = 0

  constructor(config: RelayClientConfig) {
    this.relayUrl = config.relayUrl
    this.sessionId = config.sessionId
    this.token = config.token
    this.onStateChange = config.onStateChange
    this.onMessage = config.onMessage
    this.onError = config.onError
  }

  /**
   * Connect to relay server via WebSocket.
   */
  async connect(): Promise<void> {
    this.shouldReconnect = true
    this.cancelReconnect()
    this.setState('connecting')

    try {
      await this.connectRelay()
    } catch (error) {
      this.setState('failed')
      const err = error instanceof Error ? error : new Error(String(error))
      this.onError?.(err)
      throw err
    }
  }

  /**
   * Disconnect and clean up resources.
   */
  disconnect(): void {
    this.shouldReconnect = false
    this.cancelReconnect()
    this.closeSocket()
    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS
    this.reconnectAttempts = 0

    this.setState('disconnected')
    console.log('[RelayClient] Disconnected')
  }

  /**
   * Send binary frame over WebSocket.
   */
  sendData(data: ArrayBuffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not open')
    }

    this.ws.send(data)
  }

  /**
   * Get current connection state.
   */
  getState(): ConnectionState {
    return this.state
  }

  /**
   * Check if relay is connected.
   */
  isConnected(): boolean {
    return this.state === 'connected' && this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /**
   * Get DataChannel state (for compatibility with WebSocket proxy).
   * Returns "open" when relay is connected, otherwise returns the connection state.
   */
  getDataChannelState(): 'connecting' | 'open' | 'closing' | 'closed' | 'none' {
    if (!this.ws) return 'none'

    switch (this.ws.readyState) {
      case WebSocket.CONNECTING:
        return 'connecting'
      case WebSocket.OPEN:
        return 'open'
      case WebSocket.CLOSING:
        return 'closing'
      case WebSocket.CLOSED:
        return 'closed'
      default:
        return 'none'
    }
  }

  /**
   * Connect to relay server.
   */
  private connectRelay(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.relayUrl}/relay/${this.sessionId}`

      console.log(`[RelayClient] Connecting to relay server: ${wsUrl}`)

      this.closeSocket()

      const ws = new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      let settled = false
      let graceTimer: number | null = null

      const clearGrace = () => {
        if (graceTimer !== null) {
          clearTimeout(graceTimer)
          graceTimer = null
        }
      }

      /** The relay accepted us (explicitly, or by staying silent). */
      const markConnected = () => {
        clearGrace()
        if (settled || this.ws !== ws) return
        settled = true
        this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS
        this.reconnectAttempts = 0
        this.setState('connected')
        resolve()
      }

      /** The relay rejected us, or the socket died. */
      const markFailed = (error: Error, permanent: boolean) => {
        clearGrace()
        if (permanent) {
          this.shouldReconnect = false
          this.cancelReconnect()
        }
        if (settled) {
          // Already resolved: report out-of-band so the UI stops showing green.
          this.setState('failed')
          this.onError?.(error)
          return
        }
        settled = true
        reject(error)
      }

      ws.onopen = () => {
        console.log('[RelayClient] Socket open, sending auth message')
        ws.send(JSON.stringify({ type: 'auth', token: this.token }))
        graceTimer = window.setTimeout(markConnected, AUTH_GRACE_MS)
      }

      ws.onerror = (event) => {
        console.error('[RelayClient] WebSocket error:', event)
        markFailed(new Error('Relay WebSocket connection failed'), false)
      }

      ws.onclose = (event) => {
        clearGrace()
        console.log(`[RelayClient] WebSocket closed (code ${event.code})`)

        if (this.ws !== ws) return
        this.ws = null

        const authFailure = event.code === WS_POLICY_VIOLATION
        const error = authFailure
          ? new RelayAuthError(
              event.reason ||
                'Relay rejected the session token (it may have expired). Sign in again.'
            )
          : new Error(`Relay connection closed (code ${event.code})`)

        markFailed(error, authFailure)
        this.setState(authFailure ? 'failed' : 'closed')
        this.scheduleReconnect()
      }

      ws.onmessage = (event) => {
        const data: unknown = event.data

        if (data instanceof ArrayBuffer) {
          // A frame came back, so the session is genuinely live.
          markConnected()
          console.log(`[RelayClient] Binary message received: ${data.byteLength} bytes`)
          this.onMessage?.(data)
          return
        }

        if (typeof data === 'string') {
          this.handleControlMessage(data, markConnected, markFailed)
          return
        }

        console.warn('[RelayClient] Received unsupported message type')
      }
    })
  }

  /**
   * Handle a JSON control frame from the relay (auth errors, and any explicit
   * acknowledgement a future relay version adds).
   */
  private handleControlMessage(
    raw: string,
    markConnected: () => void,
    markFailed: (error: Error, permanent: boolean) => void
  ): void {
    let parsed: RelayControlMessage
    try {
      parsed = JSON.parse(raw) as RelayControlMessage
    } catch {
      console.warn('[RelayClient] Ignoring non-JSON text frame')
      return
    }

    const type = typeof parsed.type === 'string' ? parsed.type : ''
    const message = typeof parsed.message === 'string' ? parsed.message : ''

    if (type === 'error') {
      markFailed(new RelayAuthError(message || 'Relay rejected the connection'), true)
      return
    }

    if (type === 'connected' || type === 'auth-ok') {
      console.log('[RelayClient] Relay acknowledged auth')
      markConnected()
      return
    }

    console.warn('[RelayClient] Unknown control message type:', type)
  }

  /**
   * Update connection state and notify callback.
   */
  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      const oldState = this.state
      this.state = state
      console.log(`[RelayClient] State change: ${oldState} → ${state}`)
      this.onStateChange?.(state)
    }
  }

  /**
   * Handle reconnection with exponential backoff and a hard attempt cap.
   */
  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer !== null) {
      return
    }

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.shouldReconnect = false
      const error = new Error(
        `Relay connection lost after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`
      )
      console.error(`[RelayClient] ${error.message}`)
      this.setState('failed')
      this.onError?.(error)
      return
    }

    this.reconnectAttempts += 1
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS)

    console.log(
      `[RelayClient] Attempting reconnect ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`
    )

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null

      // Re-check at fire time: disconnect() between scheduling and firing must win.
      if (!this.shouldReconnect) {
        console.log('[RelayClient] Reconnect cancelled')
        return
      }

      this.connect().catch((error: unknown) => {
        console.error('[RelayClient] Reconnect failed:', error)
      })
    }, delay)
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /**
   * Close the socket and detach handlers so a stale socket can never drive
   * state changes or reconnection.
   */
  private closeSocket(): void {
    const ws = this.ws
    if (!ws) return

    this.ws = null
    ws.onopen = null
    ws.onmessage = null
    ws.onerror = null
    ws.onclose = null

    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
  }
}
