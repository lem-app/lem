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
 * HTTP proxy over WebRTC DataChannel or WebSocket Relay.
 *
 * Provides a fetch()-like API that proxies requests through either
 * WebRTC DataChannel (P2P) or WebSocket Relay (fallback).
 */

import type { WebRTCConnectionManager } from './webrtc'
import type { RelayClient } from './relay-client'
import { serializeRequest, deserializeResponse, type HTTPResponseFrame } from './http-frame'

/** How long a tunneled request may stay outstanding before it is failed. */
const REQUEST_TIMEOUT_MS = 30000

/**
 * Pending request awaiting response.
 */
interface PendingRequest {
  resolve: (response: Response) => void
  reject: (error: Error) => void
}

/**
 * Transport abstraction for sending data.
 */
export interface Transport {
  sendData(data: ArrayBuffer): void
  isOpen(): boolean
}

/**
 * WebRTC DataChannel transport adapter.
 */
export class WebRTCTransport implements Transport {
  private webrtc: WebRTCConnectionManager

  constructor(webrtc: WebRTCConnectionManager) {
    this.webrtc = webrtc
  }

  sendData(data: ArrayBuffer): void {
    this.webrtc.sendData(data)
  }

  isOpen(): boolean {
    return this.webrtc.getDataChannelState() === 'open'
  }
}

/**
 * Relay WebSocket transport adapter.
 */
export class RelayTransport implements Transport {
  private relay: RelayClient

  constructor(relay: RelayClient) {
    this.relay = relay
  }

  sendData(data: ArrayBuffer): void {
    this.relay.sendData(data)
  }

  isOpen(): boolean {
    return this.relay.isConnected()
  }
}

/**
 * HTTP proxy manager.
 *
 * Manages request/response correlation and provides fetch()-like API.
 * Works with either WebRTC DataChannel or WebSocket Relay transport.
 */
export class HTTPProxy {
  private transport: Transport
  private nextRequestId = 1
  private pendingRequests = new Map<number, PendingRequest>()

  constructor(transport: Transport) {
    this.transport = transport
  }

  /**
   * Update the transport (used when switching from WebRTC to Relay).
   */
  setTransport(transport: Transport): void {
    this.transport = transport
  }

  /**
   * Proxy fetch() implementation.
   *
   * Sends HTTP request over DataChannel and returns Response.
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    // Parse URL
    const urlObj = new URL(url)

    // Add client parameter if present in current page URL
    const pageParams = new URLSearchParams(window.location.search)
    const clientParam = pageParams.get('client')
    if (clientParam) {
      urlObj.searchParams.set('client', clientParam)
      console.log(`[ProxyFetch] Added client parameter: ${clientParam}`)
    }

    const path = urlObj.pathname + urlObj.search

    // Extract method, headers, and body
    const method = init?.method || 'GET'
    const headers: Record<string, string> = {}

    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headers[key] = value
        })
      } else if (Array.isArray(init.headers)) {
        init.headers.forEach(([key, value]) => {
          headers[key] = value
        })
      } else {
        Object.entries(init.headers).forEach(([key, value]) => {
          headers[key] = value
        })
      }
    }

    // Get body.
    //
    // The wire format carries a UTF-8 string, so only text-shaped bodies round
    // trip. Anything else (Blob, ArrayBuffer, streams) is rejected loudly rather
    // than silently sent as "[object Object]"; binary bodies belong to the
    // tunnel-protocol track.
    let body = ''
    if (init?.body !== undefined && init.body !== null) {
      if (typeof init.body === 'string') {
        body = init.body
      } else if (init.body instanceof URLSearchParams) {
        body = init.body.toString()
      } else if (init.body instanceof FormData) {
        // Convert FormData to JSON (simplified)
        const formObj: Record<string, string> = {}
        init.body.forEach((value, key) => {
          formObj[key] = typeof value === 'string' ? value : value.name
        })
        body = JSON.stringify(formObj)
        headers['Content-Type'] = 'application/json'
      } else {
        throw new TypeError('proxyFetch only supports string, URLSearchParams and FormData bodies')
      }
    }

    // Generate request ID
    const requestId = this.nextRequestId++

    // Serialize request
    const frame = serializeRequest({
      requestId,
      method,
      path,
      headers,
      body,
    })

    // Send over DataChannel
    return new Promise<Response>((resolve, reject) => {
      let timeout: number | null = null

      // Single settle path. The previous version deleted the entry in its catch
      // block and then *fell through* to re-insert it, so every send failure
      // leaked a permanently-pending entry into the map.
      const settle = () => {
        if (timeout !== null) {
          clearTimeout(timeout)
          timeout = null
        }
        this.pendingRequests.delete(requestId)
      }

      const pending: PendingRequest = {
        resolve: (response: Response) => {
          settle()
          resolve(response)
        },
        reject: (error: Error) => {
          settle()
          reject(error)
        },
      }

      this.pendingRequests.set(requestId, pending)

      timeout = window.setTimeout(() => {
        timeout = null
        pending.reject(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`))
      }, REQUEST_TIMEOUT_MS)

      try {
        if (!this.transport.isOpen()) {
          throw new Error('Transport not open')
        }

        // Send ArrayBuffer over transport (DataChannel or WebSocket)
        this.transport.sendData(frame)
        console.log(`[ProxyFetch] Sent request ${requestId}: ${method} ${path}`)
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * Number of requests still awaiting a response. Exposed for tests and
   * diagnostics - a monotonically growing value means responses are being lost.
   */
  get pendingCount(): number {
    return this.pendingRequests.size
  }

  /**
   * Handle incoming response frame.
   *
   * Called by WebRTC client when response is received.
   */
  handleResponse(buffer: ArrayBuffer): void {
    try {
      // Deserialize response
      const frame = deserializeResponse(buffer)
      console.log(`[ProxyFetch] Received response ${frame.requestId}: ${frame.statusCode}`)

      // Find pending request
      const pending = this.pendingRequests.get(frame.requestId)
      if (!pending) {
        console.warn(`[ProxyFetch] No pending request for ID ${frame.requestId}`)
        return
      }

      // Remove from pending
      this.pendingRequests.delete(frame.requestId)

      // Create Response object
      const response = this.createResponse(frame)

      // NOTE on 401s: a 401 arriving here came from the *local* Lem server at
      // the far end of the tunnel, which authenticates separately from the
      // cloud session this browser holds a JWT for. Dropping the cloud session
      // on it would log the user out for an unrelated failure, so the status is
      // handed to the caller untouched. Cloud-session 401s are intercepted in
      // `api/auth.ts`, and relay/signaling token rejection surfaces through
      // `RelayAuthError`.
      if (frame.statusCode === 401 || frame.statusCode === 403) {
        console.warn(
          `[ProxyFetch] Local server rejected request ${frame.requestId} with ${frame.statusCode}`
        )
      }

      pending.resolve(response)
    } catch (error) {
      console.error('[ProxyFetch] Error handling response:', error)
    }
  }

  /**
   * Create Response object from frame.
   */
  private createResponse(frame: HTTPResponseFrame): Response {
    // Create Headers object
    const headers = new Headers()
    Object.entries(frame.headers).forEach(([key, value]) => {
      headers.set(key, value)
    })

    // Create Response
    return new Response(frame.body, {
      status: frame.statusCode,
      headers,
    })
  }

  /**
   * Fail every outstanding request. Called when the transport goes away so the
   * map cannot accumulate resolvers nobody will ever call.
   */
  clearPending(): void {
    const pending = [...this.pendingRequests.values()]
    this.pendingRequests.clear()
    pending.forEach((request) => {
      request.reject(new Error('Connection closed'))
    })
  }
}
