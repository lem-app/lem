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
 */

import type { ConnectionState } from '../api/types'

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
  private reconnectDelay = 2000
  private maxReconnectDelay = 60000

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

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

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
  private async connectRelay(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Build WebSocket URL: ws://localhost:8001/relay/{session_id}?token={jwt}
      const wsUrl = `${this.relayUrl}/relay/${this.sessionId}?token=${this.token}`

      console.log(`[RelayClient] Connecting to relay server: ${wsUrl}`)

      this.ws = new WebSocket(wsUrl)
      this.ws.binaryType = 'arraybuffer'

      this.ws.onopen = () => {
        console.log('[RelayClient] Connected to relay server')
        this.setState('connected')
        resolve()
      }

      this.ws.onerror = (event) => {
        console.error('[RelayClient] WebSocket error:', event)
        reject(new Error('WebSocket connection failed'))
      }

      this.ws.onclose = () => {
        console.log('[RelayClient] WebSocket closed')
        this.setState('closed')
        this.handleReconnect()
      }

      this.ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          console.log(`[RelayClient] Binary message received: ${event.data.byteLength} bytes`)
          this.onMessage?.(event.data)
        } else {
          console.warn('[RelayClient] Received non-binary message:', event.data)
        }
      }
    })
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
   * Handle reconnection with exponential backoff.
   */
  private handleReconnect(): void {
    if (!this.shouldReconnect) {
      return
    }

    console.log(`[RelayClient] Attempting reconnect in ${this.reconnectDelay}ms...`)

    setTimeout(async () => {
      try {
        await this.connect()

        // Reset delay on successful reconnect
        this.reconnectDelay = 2000
      } catch (error) {
        console.error('[RelayClient] Reconnect failed:', error)
      }
    }, this.reconnectDelay)

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay)
  }
}
