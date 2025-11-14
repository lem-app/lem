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
 * WebSocket interception for transparent proxying.
 *
 * Overrides window.WebSocket to automatically proxy connections through
 * the WebRTC DataChannel when appropriate.
 */

import type { WSProxyManager } from './ws-proxy'

/**
 * Original WebSocket constructor reference.
 */
let OriginalWebSocket: typeof WebSocket | null = null

/**
 * Active WSProxyManager instance.
 */
let activeProxyManager: WSProxyManager | null = null

/**
 * Determine if a WebSocket URL should be proxied.
 *
 * Proxying rules:
 * 1. NEVER proxy the signaling server WebSocket (used for WebRTC setup)
 * 2. If the current page has ?client= parameter, proxy WebSocket connections to local server
 * 3. If the WebSocket URL has ?client= parameter, proxy it
 *
 * The signaling server WebSocket is the control channel for WebRTC and must use native WebSocket.
 * Only WebSockets to the local server (through the established DataChannel) should be proxied.
 */
function shouldProxyWebSocket(url: string): boolean {
  try {
    // Parse WebSocket URL
    const wsUrl = new URL(url, window.location.href)

    // NEVER proxy the signaling server WebSocket
    // The signaling server is used to establish the WebRTC connection itself
    if (wsUrl.pathname.includes('/signal')) {
      console.log('[WSIntercept] NOT proxying signaling server WebSocket:', url)
      return false
    }

    // Check if WebSocket URL has ?client= parameter - explicit proxy request
    if (wsUrl.searchParams.has('client')) {
      console.log('[WSIntercept] Proxying WebSocket - URL has client param')
      return true
    }

    // Check if current page has ?client= parameter
    const pageParams = new URLSearchParams(window.location.search)
    const clientParam = pageParams.get('client')
    if (clientParam) {
      console.log('[WSIntercept] Proxying WebSocket - client mode active:', clientParam)
      return true
    }

    // Don't proxy by default
    console.log('[WSIntercept] NOT proxying WebSocket:', url)
    return false
  } catch (error) {
    console.error('[WSIntercept] Error checking if should proxy:', error)
    return false
  }
}

/**
 * Setup WebSocket interception.
 *
 * Replaces window.WebSocket with a wrapper that automatically uses
 * ProxiedWebSocket when appropriate.
 *
 * @param wsProxyManager - The WSProxyManager instance to use for proxied connections
 */
export function setupWebSocketIntercept(wsProxyManager: WSProxyManager): void {
  // Save original WebSocket if not already saved
  if (!OriginalWebSocket) {
    OriginalWebSocket = window.WebSocket
    console.log('[WSIntercept] Saved original WebSocket constructor')
  }

  // Store proxy manager reference
  activeProxyManager = wsProxyManager

  // Create wrapper constructor
  const ProxiedWebSocketConstructor = function (
    this: WebSocket,
    url: string | URL,
    protocols?: string | string[]
  ): WebSocket {
    const urlString = url instanceof URL ? url.toString() : url

    // Check if we should proxy this connection
    if (shouldProxyWebSocket(urlString) && activeProxyManager) {
      console.log('[WSIntercept] Creating proxied WebSocket for:', urlString)
      return activeProxyManager.createConnection(urlString, protocols) as unknown as WebSocket
    }

    // Use native WebSocket
    console.log('[WSIntercept] Using native WebSocket for:', urlString)
    if (protocols !== undefined) {
      return new OriginalWebSocket!(urlString, protocols)
    }
    return new OriginalWebSocket!(urlString)
  } as unknown as typeof WebSocket

  // Copy static properties from original WebSocket
  ProxiedWebSocketConstructor.CONNECTING = OriginalWebSocket.CONNECTING
  ProxiedWebSocketConstructor.OPEN = OriginalWebSocket.OPEN
  ProxiedWebSocketConstructor.CLOSING = OriginalWebSocket.CLOSING
  ProxiedWebSocketConstructor.CLOSED = OriginalWebSocket.CLOSED

  // Replace window.WebSocket
  window.WebSocket = ProxiedWebSocketConstructor
  console.log('[WSIntercept] WebSocket interception enabled')
}

/**
 * Restore original WebSocket constructor.
 *
 * Removes interception and restores native WebSocket behavior.
 */
export function teardownWebSocketIntercept(): void {
  if (OriginalWebSocket) {
    window.WebSocket = OriginalWebSocket
    console.log('[WSIntercept] WebSocket interception disabled - restored original')
  }

  activeProxyManager = null
}

/**
 * Check if WebSocket interception is currently active.
 */
export function isWebSocketInterceptActive(): boolean {
  return window.WebSocket !== OriginalWebSocket && OriginalWebSocket !== null
}
