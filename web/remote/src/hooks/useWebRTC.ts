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
  relayUrl?: string
}

/**
 * Connection mode: WebRTC P2P or Relay fallback.
 */
export type ConnectionMode = 'webrtc' | 'relay'

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
  const interceptSetupRef = useRef<boolean>(false)
  const webrtcFailureCountRef = useRef<number>(0)
  const isRelayFallbackRef = useRef<boolean>(false)
  const fallbackToRelayRef = useRef<(() => Promise<void>) | null>(null)

  // Setup WebSocket interception ONCE on mount (not tied to WebRTC manager lifecycle)
  // This prevents React Strict Mode from tearing down and re-setting up interception
  useEffect(() => {
    if (interceptSetupRef.current) {
      return // Already set up
    }

    console.log('[useWebRTC] Setting up WebSocket interception (one-time)')
    interceptSetupRef.current = true

    return () => {
      console.log('[useWebRTC] Tearing down WebSocket interception (component unmount)')
      teardownWebSocketIntercept()
      interceptSetupRef.current = false
    }
  }, []) // Empty deps - run once on mount

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
      onStateChange: (state) => {
        setConnectionState(state)

        // Handle WebRTC failure - fall back to relay after 3 attempts
        if (state === 'failed' && !isRelayFallbackRef.current) {
          webrtcFailureCountRef.current++
          console.log(`[useWebRTC] WebRTC failure count: ${webrtcFailureCountRef.current}`)

          if (webrtcFailureCountRef.current >= 3) {
            console.log('[useWebRTC] WebRTC failed 3 times, falling back to relay')
            isRelayFallbackRef.current = true

            // Stop WebRTC reconnection but keep signaling WebSocket open
            // We need it to send connect-request messages
            if (managerRef.current) {
              managerRef.current.stopReconnection()
            }

            fallbackToRelay()
          }
        }
      },
      onDataChannelMessage: (message) => {
        // Handle binary messages - route by frame type
        if (message instanceof ArrayBuffer) {
          // Read frame type (first byte)
          const view = new DataView(message)
          const frameType = view.getUint8(0)

          if (frameType === FrameType.HTTP_RESPONSE) {
            // HTTP response - route to HTTP proxy
            httpProxyRef.current?.handleResponse(message)
          } else if (frameType === FrameType.WS_DATA) {
            // WebSocket data - route to WS proxy manager
            wsProxyManagerRef.current?.handleDataFrame(message)
          } else if (frameType === FrameType.WS_CLOSE) {
            // WebSocket close - route to WS proxy manager
            wsProxyManagerRef.current?.handleCloseFrame(message)
          } else {
            console.warn(`[useWebRTC] Unknown frame type: 0x${frameType.toString(16)}`)
          }
        } else {
          // Text messages go to messages state
          setMessages((prev) => [...prev, message])
        }
      },
      onError: (err) => {
        setError(err)
      },
    })

    managerRef.current = manager

    // Create HTTP proxy instance with WebRTC transport
    const webrtcTransport = new WebRTCTransport(manager)
    httpProxyRef.current = new HTTPProxy(webrtcTransport)

    // Create WebSocket proxy manager
    wsProxyManagerRef.current = new WSProxyManager(manager)

    // Update WebSocket interception with new proxy manager
    // (interception is already set up, just update the manager reference)
    setupWebSocketIntercept(wsProxyManagerRef.current)

    // Poll for DataChannel state changes
    pollingIntervalRef.current = window.setInterval(() => {
      // Check relay client state if in relay mode, otherwise check WebRTC
      // Use ref to avoid closure issues
      if (relayClientRef.current && connectionModeRef.current === 'relay') {
        const state = relayClientRef.current.getDataChannelState()
        setDataChannelState(state)
      } else if (managerRef.current) {
        const state = managerRef.current.getDataChannelState()
        setDataChannelState(state)
      }
    }, 500)

    // Fallback to relay function
    const fallbackToRelay = async () => {
      console.log('[useWebRTC] Falling back to relay')
      setConnectionMode('relay')
      connectionModeRef.current = 'relay'

      const relayUrl = options.relayUrl || 'ws://localhost:8001'
      const sessionId = generateSessionId(options.deviceId, options.targetDeviceId)

      try {
        // Send connect-request with relay preference
        console.log('[useWebRTC] Sending connect-request for relay mode')
        const ack = await managerRef.current?.sendConnectRequest('relay', sessionId)

        if (!ack || ack.status === 'failed') {
          throw new Error('Server rejected relay connection request')
        }

        console.log('[useWebRTC] Server acknowledged relay connection:', ack.status)

        // Server has confirmed relay mode, now connect to relay
        const relayClient = new RelayClient({
          relayUrl,
          sessionId,
          token: options.token,
          onStateChange: (state) => {
            setConnectionState(state)
          },
          onMessage: (message) => {
            // Handle binary messages - route by frame type (same as WebRTC)
            if (message instanceof ArrayBuffer) {
              const view = new DataView(message)
              const frameType = view.getUint8(0)

              if (frameType === FrameType.HTTP_RESPONSE) {
                httpProxyRef.current?.handleResponse(message)
              } else if (frameType === FrameType.WS_DATA) {
                wsProxyManagerRef.current?.handleDataFrame(message)
              } else if (frameType === FrameType.WS_CLOSE) {
                wsProxyManagerRef.current?.handleCloseFrame(message)
              } else {
                console.warn(`[useWebRTC] Unknown frame type: 0x${frameType.toString(16)}`)
              }
            }
          },
          onError: (err) => {
            setError(err)
          },
        })

        relayClientRef.current = relayClient

        // Connect to relay first
        await relayClient.connect()
        console.log('[useWebRTC] Successfully connected via relay')

        // Now that relay is connected, switch HTTP proxy to use relay transport
        if (httpProxyRef.current) {
          const relayTransport = new RelayTransport(relayClient)
          httpProxyRef.current.setTransport(relayTransport)
        }

        // Update WebSocket proxy manager to use relay client
        // Do this AFTER connecting so WebSocket connections work immediately
        if (wsProxyManagerRef.current) {
          wsProxyManagerRef.current.updateConnectionManager(relayClient)
        }

        // Clear any previous WebRTC errors since relay connected successfully
        setError(null)
      } catch (err) {
        console.error('[useWebRTC] Relay connection failed:', err)
        setError(err instanceof Error ? err : new Error(String(err)))
      }
    }

    // Store fallback function in ref so it's accessible from connect callback
    fallbackToRelayRef.current = fallbackToRelay

    return () => {
      if (pollingIntervalRef.current !== null) {
        clearInterval(pollingIntervalRef.current)
      }
      // Clean up WebSocket connections (but NOT interception - that stays active)
      if (wsProxyManagerRef.current) {
        wsProxyManagerRef.current.closeAll()
      }
      if (managerRef.current) {
        managerRef.current.disconnect()
      }
      if (relayClientRef.current) {
        relayClientRef.current.disconnect()
      }
    }
  }, [options.signalUrl, options.token, options.deviceId, options.targetDeviceId, options.relayUrl])

  // Auto-connect if enabled
  useEffect(() => {
    if (options.autoConnect && managerRef.current && connectionState === 'disconnected') {
      managerRef.current.connect().catch((err) => {
        console.error('[useWebRTC] Auto-connect failed:', err)
      })
    }
  }, [options.autoConnect, connectionState])

  const connect = useCallback(async () => {
    if (!managerRef.current) {
      throw new Error('WebRTC manager not initialized')
    }
    setError(null)

    // Check if WebRTC is available upfront
    if (typeof RTCPeerConnection === 'undefined') {
      console.log('[useWebRTC] RTCPeerConnection not available, using relay mode directly')
      isRelayFallbackRef.current = true
      setConnectionMode('relay')
      connectionModeRef.current = 'relay'

      // Connect to signaling first (needed for connect-request)
      await managerRef.current.connectSignalingOnly()

      // Then fall back to relay
      if (fallbackToRelayRef.current) {
        await fallbackToRelayRef.current()
      }
      return
    }

    await managerRef.current.connect()
  }, [])

  const disconnect = useCallback(() => {
    if (managerRef.current) {
      managerRef.current.disconnect()
    }
  }, [])

  const sendData = useCallback((data: string) => {
    if (!managerRef.current) {
      throw new Error('WebRTC manager not initialized')
    }
    managerRef.current.sendData(data)
  }, [])

  const proxyFetch = useCallback(
    async (url: string, init?: RequestInit): Promise<Response> => {
      if (!httpProxyRef.current) {
        throw new Error('HTTP proxy not initialized')
      }
      return httpProxyRef.current.fetch(url, init)
    },
    []
  )

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
