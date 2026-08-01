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
 * WebRTC connection hook with relay fallback.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { WebRTCConnectionManager } from '../lib/webrtc'
import { RelayClient } from '../lib/relay-client'
import { HTTPProxy, WebRTCTransport, RelayTransport } from '../lib/proxy-fetch'
import { WSProxyManager } from '../lib/ws-proxy'
import { setupWebSocketIntercept, teardownWebSocketIntercept } from '../lib/websocket-intercept'
import { FrameType } from '../lib/http-frame'
import type { ConnectionState, DataChannelState } from '../api/types'

interface UseWebRTCOptions {
  signalUrl: string
  token: string
  deviceId: string
  targetDeviceId: string
  autoConnect?: boolean
  relayUrl: string
  iceServers?: RTCIceServer[]
}

/**
 * Connection mode: WebRTC P2P or Relay fallback.
 */
export type ConnectionMode = 'webrtc' | 'relay'

/**
 * How many WebRTC failures to tolerate before switching to the relay.
 *
 * One. The manager's own 10s connection timeout is already the "give WebRTC a
 * fair chance" budget, and it retries with backoff on its own; waiting for a
 * second reported failure pushed relay fallback past a minute.
 */
const WEBRTC_FAILURE_THRESHOLD = 1

const DATA_CHANNEL_POLL_MS = 500

/**
 * Generate a session ID for relay connection.
 * Format: {browser_device_id}-{target_device_id}
 */
function generateSessionId(browserDeviceId: string, targetDeviceId: string): string {
  return `${browserDeviceId}-${targetDeviceId}`
}

export function useWebRTC(options: UseWebRTCOptions) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected')
  const [dataChannelState, setDataChannelState] = useState<DataChannelState>('none')
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('webrtc')
  const [error, setError] = useState<Error | null>(null)
  const [messages, setMessages] = useState<string[]>([])

  // Use ref for connectionMode so polling interval can see updates
  const connectionModeRef = useRef<ConnectionMode>('webrtc')

  const managerRef = useRef<WebRTCConnectionManager | null>(null)
  const relayClientRef = useRef<RelayClient | null>(null)
  const httpProxyRef = useRef<HTTPProxy | null>(null)
  const wsProxyManagerRef = useRef<WSProxyManager | null>(null)
  const pollingIntervalRef = useRef<number | null>(null)
  const webrtcFailureCountRef = useRef<number>(0)
  const isRelayFallbackRef = useRef<boolean>(false)
  const fallbackToRelayRef = useRef<(() => Promise<void>) | null>(null)

  /**
   * Tear every transport down and put the hook back in its initial shape.
   *
   * `disconnect()` used to close only the WebRTC manager. On the relay path the
   * relay socket stayed open, `RelayClient` kept reconnecting it, and frames
   * carried on flowing after the UI said "disconnected". The transport-mode
   * bookkeeping was never reset either, so the next connection was mislabelled
   * and the 500ms poller read the wrong transport.
   */
  const teardown = useCallback(() => {
    if (relayClientRef.current) {
      relayClientRef.current.disconnect()
      relayClientRef.current = null
    }

    managerRef.current?.disconnect()

    // Fail anything still waiting on the tunnel rather than leaking resolvers.
    httpProxyRef.current?.clearPending()

    wsProxyManagerRef.current?.closeAll()

    // Point the proxies back at the WebRTC transport for the next attempt.
    if (managerRef.current) {
      const webrtcTransport = new WebRTCTransport(managerRef.current)
      httpProxyRef.current?.setTransport(webrtcTransport)
      wsProxyManagerRef.current?.updateTransport(webrtcTransport)
    }

    connectionModeRef.current = 'webrtc'
    isRelayFallbackRef.current = false
    webrtcFailureCountRef.current = 0
    setConnectionMode('webrtc')
    setDataChannelState('none')
  }, [])

  // Tear WebSocket interception down when the component unmounts. Setup happens
  // alongside the proxy manager below (this effect used to claim it set up
  // interception but never called setupWebSocketIntercept).
  useEffect(() => {
    return () => {
      console.log('[useWebRTC] Tearing down WebSocket interception (component unmount)')
      teardownWebSocketIntercept()
    }
  }, [])

  // Initialize WebRTC manager
  useEffect(() => {
    if (!options.token || !options.deviceId || !options.targetDeviceId) {
      return
    }

    const manager = new WebRTCConnectionManager({
      signalUrl: options.signalUrl,
      token: options.token,
      deviceId: options.deviceId,
      targetDeviceId: options.targetDeviceId,
      iceServers: options.iceServers,
      onStateChange: setConnectionState,
      onConnectionFailed: () => {
        // Every failure is reported here, undeduplicated - unlike onStateChange,
        // which suppresses failed→failed and so never reached the threshold.
        if (isRelayFallbackRef.current) return

        webrtcFailureCountRef.current += 1
        console.log(`[useWebRTC] WebRTC failure count: ${webrtcFailureCountRef.current}`)

        if (webrtcFailureCountRef.current < WEBRTC_FAILURE_THRESHOLD) return

        console.log('[useWebRTC] Falling back to relay')
        isRelayFallbackRef.current = true

        // Stop WebRTC reconnection but keep the signaling WebSocket open -
        // we still need it to send connect-request messages.
        managerRef.current?.stopReconnection()

        void fallbackToRelayRef.current?.()
      },
      onDataChannelMessage: (message) => {
        // Handle binary messages - route by frame type
        if (message instanceof ArrayBuffer) {
          routeBinaryFrame(message)
        } else {
          // Text messages go to messages state
          setMessages((prev) => [...prev, message])
        }
      },
      onError: setError,
    })

    managerRef.current = manager

    // Create HTTP proxy and WebSocket proxy manager over the WebRTC transport
    const webrtcTransport = new WebRTCTransport(manager)
    const httpProxy = new HTTPProxy(webrtcTransport)
    const wsProxyManager = new WSProxyManager(webrtcTransport)
    httpProxyRef.current = httpProxy
    wsProxyManagerRef.current = wsProxyManager

    function routeBinaryFrame(message: ArrayBuffer): void {
      const frameType = new DataView(message).getUint8(0)

      if (frameType === FrameType.HTTP_RESPONSE) {
        httpProxy.handleResponse(message)
      } else if (frameType === FrameType.WS_DATA) {
        wsProxyManager.handleDataFrame(message)
      } else if (frameType === FrameType.WS_CLOSE) {
        wsProxyManager.handleCloseFrame(message)
      } else {
        console.warn(`[useWebRTC] Unknown frame type: 0x${frameType.toString(16)}`)
      }
    }

    // Install (or re-point) WebSocket interception for this proxy manager
    setupWebSocketIntercept(wsProxyManager)

    // Poll for DataChannel state changes
    pollingIntervalRef.current = window.setInterval(() => {
      // Check relay client state if in relay mode, otherwise check WebRTC.
      // Uses refs to avoid closure issues.
      if (relayClientRef.current && connectionModeRef.current === 'relay') {
        setDataChannelState(relayClientRef.current.getDataChannelState())
      } else if (managerRef.current) {
        setDataChannelState(managerRef.current.getDataChannelState())
      }
    }, DATA_CHANNEL_POLL_MS)

    // Fallback to relay function
    const fallbackToRelay = async () => {
      console.log('[useWebRTC] Falling back to relay')
      setConnectionMode('relay')
      connectionModeRef.current = 'relay'

      const sessionId = generateSessionId(options.deviceId, options.targetDeviceId)

      try {
        // Send connect-request with relay preference
        console.log('[useWebRTC] Sending connect-request for relay mode')
        const ack = await manager.sendConnectRequest('relay', sessionId)

        if (ack.status === 'failed') {
          throw new Error('Server rejected relay connection request')
        }

        console.log('[useWebRTC] Server acknowledged relay connection:', ack.status)

        // Server has confirmed relay mode, now connect to relay
        const relayClient = new RelayClient({
          relayUrl: options.relayUrl,
          sessionId,
          token: options.token,
          onStateChange: setConnectionState,
          onMessage: routeBinaryFrame,
          onError: setError,
        })

        relayClientRef.current = relayClient

        // Connect to relay first
        await relayClient.connect()
        console.log('[useWebRTC] Successfully connected via relay')

        // Now that relay is connected, switch both proxies to the relay transport
        const relayTransport = new RelayTransport(relayClient)
        httpProxy.setTransport(relayTransport)
        wsProxyManager.updateTransport(relayTransport)

        // Clear any previous WebRTC errors since relay connected successfully
        setError(null)
      } catch (err) {
        console.error('[useWebRTC] Relay connection failed:', err)
        setError(err instanceof Error ? err : new Error(String(err)))
      }
    }

    // Store fallback function in ref so it's accessible from the failure callback
    fallbackToRelayRef.current = fallbackToRelay

    return () => {
      if (pollingIntervalRef.current !== null) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }
      fallbackToRelayRef.current = null
      // Clean up connections (but NOT interception - that stays active)
      teardown()
    }
  }, [
    options.signalUrl,
    options.token,
    options.deviceId,
    options.targetDeviceId,
    options.relayUrl,
    options.iceServers,
    teardown,
  ])

  const connect = useCallback(async (): Promise<void> => {
    const manager = managerRef.current
    if (!manager) {
      setError(new Error('WebRTC manager not initialized'))
      return
    }

    setError(null)
    webrtcFailureCountRef.current = 0

    try {
      // Check if WebRTC is available upfront
      if (typeof RTCPeerConnection === 'undefined') {
        console.log('[useWebRTC] RTCPeerConnection not available, using relay mode directly')
        isRelayFallbackRef.current = true
        setConnectionMode('relay')
        connectionModeRef.current = 'relay'

        // Connect to signaling first (needed for connect-request)
        await manager.connectSignalingOnly()

        // Then fall back to relay
        await fallbackToRelayRef.current?.()
        return
      }

      await manager.connect()
    } catch (err) {
      // Never reject: the failure is already surfaced through `error`, and a
      // rejected promise from an onClick handler is an unhandled rejection.
      console.error('[useWebRTC] Connect failed:', err)
      setError(err instanceof Error ? err : new Error(String(err)))
    }
  }, [])

  const disconnect = useCallback(() => {
    teardown()
    setConnectionState('disconnected')
    setError(null)
  }, [teardown])

  const sendData = useCallback((data: string) => {
    if (!managerRef.current) {
      throw new Error('WebRTC manager not initialized')
    }
    managerRef.current.sendData(data)
  }, [])

  const proxyFetch = useCallback(async (url: string, init?: RequestInit): Promise<Response> => {
    if (!httpProxyRef.current) {
      throw new Error('HTTP proxy not initialized')
    }
    return httpProxyRef.current.fetch(url, init)
  }, [])

  // Auto-connect if enabled
  useEffect(() => {
    if (options.autoConnect && managerRef.current && connectionState === 'disconnected') {
      void connect()
    }
  }, [options.autoConnect, connectionState, connect])

  return {
    connectionState,
    dataChannelState,
    connectionMode,
    error,
    messages,
    connect,
    disconnect,
    sendData,
    proxyFetch,
    wsProxyManager: wsProxyManagerRef.current,
  }
}
