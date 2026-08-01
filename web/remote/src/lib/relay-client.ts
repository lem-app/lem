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
 * 2. classifies an explicit `{"type": "error"}` control frame by its own
 *    `reason` / `retryable` fields - terminal rejections stop reconnection and
 *    are surfaced to the caller, retryable ones (a busy relay) back off and
 *    retry - and falls back to the close code (1008 terminal, 1013 retryable)
 *    only when no frame arrived,
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
 * The relay refused this connection.
 *
 * `retryable` comes off the error frame itself, not from the close code: the
 * relay sends the two independently and the frame arrives first (and sometimes
 * the close never arrives at all). Conflating them turned "the relay is busy,
 * come back in a moment" into "sign in again" and disabled relay reconnection
 * for the whole session.
 */
export class RelayRejectedError extends Error {
  readonly reason: string
  readonly retryable: boolean

  constructor(message: string, reason: string, retryable: boolean) {
    super(message)
    this.name = 'RelayRejectedError'
    this.reason = reason
    this.retryable = retryable
  }
}

/**
 * Raised when the relay rejects our credentials. Reconnecting will not help;
 * the user has to authenticate again.
 */
export class RelayAuthError extends RelayRejectedError {
  constructor(message: string, reason = 'auth-failed') {
    super(message, reason, false)
    this.name = 'RelayAuthError'
  }
}

/**
 * Reason codes from `cloud/relay/app/core/errors.py` that mean "the same
 * request may succeed later, unchanged". Used only when a relay omits the
 * explicit `retryable` boolean; the boolean wins when present.
 */
const RETRYABLE_REASONS = new Set(['relay-at-capacity', 'account-session-limit'])

/** Reason codes whose cure is new credentials rather than a different request. */
const AUTH_REASONS = new Set(['auth-failed', 'grant-already-used', 'session-mismatch'])

/** Fallback text per reason, used when the relay sends no message. */
const FALLBACK_MESSAGES: Record<string, string> = {
  'relay-at-capacity': 'The relay is busy right now. Retrying automatically.',
  'account-session-limit':
    'This account already has as many relay sessions open as it may. Close another session, or wait and retry.',
  'grant-already-used': 'This relay session grant was already used. Reconnecting to get a new one.',
  'session-mismatch': 'This relay session belongs to a different device pair.',
  'device-already-connected': 'This device is already connected to that relay session.',
  'session-full': 'That relay session already has both sides connected.',
  'session-closed': 'That relay session was closed.',
  'unsupported-client': 'This Lem client is too old for the relay. Update Lem.',
  'protocol-error': 'The relay rejected our handshake.',
}

/**
 * Turn a relay error frame into a typed error.
 *
 * A capacity rejection must never tell the user to sign in again - that is the
 * whole point of the `reason` field.
 */
function buildRejection(reason: string, message: string, retryable: boolean): RelayRejectedError {
  const text =
    message ||
    FALLBACK_MESSAGES[reason] ||
    (retryable
      ? 'The relay is temporarily unavailable. Retrying automatically.'
      : 'The relay rejected the connection.')

  if (!retryable && (AUTH_REASONS.has(reason) || reason === '')) {
    return new RelayAuthError(
      message || 'Relay rejected the session token (it may have expired). Sign in again.',
      reason || 'auth-failed'
    )
  }
  return new RelayRejectedError(text, reason, retryable)
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

/** WebSocket close code the relay uses for capacity rejections: retry later. */
const WS_TRY_AGAIN_LATER = 1013

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
  reason?: unknown
  retryable?: unknown
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

  // Last classified rejection, kept so the close handler reports what the
  // error frame already established rather than a generic "closed (code N)".
  private lastRejection: RelayRejectedError | null = null

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
    // An explicit connect() is a fresh decision by the caller: a terminal
    // rejection from a previous attempt must not colour this one.
    this.lastRejection = null
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

        // The error frame, if one arrived, already classified this close. Only
        // fall back to the close code when it did not: 1013 is "try again
        // later" and must not be reported as an authentication failure.
        const rejection = this.lastRejection
        const permanent = rejection ? !rejection.retryable : event.code === WS_POLICY_VIOLATION

        let error: Error
        if (rejection) {
          error = rejection
        } else if (event.code === WS_POLICY_VIOLATION) {
          error = new RelayAuthError(
            event.reason || 'Relay rejected the session token (it may have expired). Sign in again.'
          )
        } else if (event.code === WS_TRY_AGAIN_LATER) {
          error = new RelayRejectedError(
            event.reason || 'The relay is busy right now. Retrying automatically.',
            'relay-at-capacity',
            true
          )
        } else {
          error = new Error(`Relay connection closed (code ${event.code})`)
        }

        markFailed(error, permanent)
        this.setState(permanent ? 'failed' : 'closed')
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
      const reason = typeof parsed.reason === 'string' ? parsed.reason : ''
      // Trust the explicit boolean; fall back to the known reason set only
      // when a relay omits it.
      const retryable =
        typeof parsed.retryable === 'boolean' ? parsed.retryable : RETRYABLE_REASONS.has(reason)

      const error = buildRejection(reason, message, retryable)
      this.lastRejection = error
      console.warn(
        `[RelayClient] Relay rejected the connection (reason=${reason || 'unspecified'}, retryable=${retryable})`
      )
      // Permanent only when the relay says so. A retryable rejection keeps
      // reconnection alive so the backoff can do its job.
      markFailed(error, !retryable)
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
