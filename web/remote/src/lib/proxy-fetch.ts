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
  constructor(private webrtc: WebRTCConnectionManager) {}

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
  constructor(private relay: RelayClient) {}

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

    // Get body
    let body = ''
    if (init?.body) {
      if (typeof init.body === 'string') {
        body = init.body
      } else if (init.body instanceof FormData) {
        // Convert FormData to JSON (simplified)
        const formObj: Record<string, string> = {}
        init.body.forEach((value, key) => {
          formObj[key] = String(value)
        })
        body = JSON.stringify(formObj)
        headers['Content-Type'] = 'application/json'
      } else {
        // For other types, try to convert to string
        body = String(init.body)
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
      // Store pending request
      this.pendingRequests.set(requestId, { resolve, reject })

      // Set timeout (30 seconds)
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error('Request timeout'))
      }, 30000)

      try {
        // Send binary frame
        if (!this.transport.isOpen()) {
          clearTimeout(timeout)
          this.pendingRequests.delete(requestId)
          reject(new Error('Transport not open'))
          return
        }

        // Send ArrayBuffer over transport (DataChannel or WebSocket)
        this.transport.sendData(frame)
        console.log(`[ProxyFetch] Sent request ${requestId}: ${method} ${path}`)
      } catch (error) {
        clearTimeout(timeout)
        this.pendingRequests.delete(requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }

      // Clean up timeout when response arrives
      const originalResolve = resolve
      this.pendingRequests.set(requestId, {
        resolve: (response: Response) => {
          clearTimeout(timeout)
          originalResolve(response)
        },
        reject: (error: Error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
    })
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
   * Clear all pending requests.
   */
  clearPending(): void {
    this.pendingRequests.forEach((pending) => {
      pending.reject(new Error('Connection closed'))
    })
    this.pendingRequests.clear()
  }
}

/**
 * Create proxyFetch function bound to WebRTC connection.
 */
export function createProxyFetch(webrtc: WebRTCConnectionManager): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  proxy: HTTPProxy
} {
  const transport = new WebRTCTransport(webrtc)
  const proxy = new HTTPProxy(transport)

  return {
    fetch: (url: string, init?: RequestInit) => proxy.fetch(url, init),
    proxy,
  }
}

/**
 * Create proxyFetch function bound to Relay connection.
 */
export function createRelayProxyFetch(relay: RelayClient): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  proxy: HTTPProxy
} {
  const transport = new RelayTransport(relay)
  const proxy = new HTTPProxy(transport)

  return {
    fetch: (url: string, init?: RequestInit) => proxy.fetch(url, init),
    proxy,
  }
}
