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
 * WebRTC connection manager for browser client.
 *
 * Manages RTCPeerConnection, WebSocket signaling, ICE candidates,
 * and DataChannel for HTTP proxying.
 */

import type {
  ChallengeMessage,
  ConnectionState,
  DataChannelState,
  ReceivedSignalingMessage,
  OfferMessage,
  AnswerMessage,
  ICECandidateMessage,
  ConnectRequestMessage,
  ConnectAckReceivedMessage,
} from '../api/types'
import { SIGNAL_CONTEXT, getDeviceIdentity } from '../api/device-key'

/**
 * WebRTC configuration options.
 */
export interface WebRTCConfig {
  signalUrl: string
  token: string
  deviceId: string
  targetDeviceId: string
  iceServers?: RTCIceServer[]
  onStateChange?: (state: ConnectionState) => void
  onDataChannelMessage?: (message: string | ArrayBuffer) => void
  onError?: (error: Error) => void
  /**
   * Fired every time the WebRTC leg fails, *without* the de-duplication that
   * `onStateChange` applies. Callers use this to drive relay fallback: relying
   * on `onStateChange('failed')` silently swallowed repeat failures because the
   * state was already `failed`.
   */
  onConnectionFailed?: (error: Error) => void
  /**
   * Answers the signaling server's proof-of-possession challenge.
   *
   * Defaults to this browser's Ed25519 device key. Injectable so tests can
   * drive the handshake without WebCrypto.
   */
  signChallenge?: (context: string, ...fields: string[]) => Promise<string>
}

/**
 * ICE servers used when neither the caller nor the signaling server supplies any.
 *
 * Deliberately empty: Lem is a privacy-first product, and silently sending every
 * user's IP address to a third-party STUN server (Google's, previously) is not
 * something we do by default. The signaling server hands out ICE servers in its
 * `connected` message; a self-hosted deployment can also set `VITE_ICE_SERVERS`.
 * With no ICE servers the connection still works over host candidates (same LAN),
 * and otherwise falls back to the relay.
 */
const DEFAULT_ICE_SERVERS: RTCIceServer[] = []

const INITIAL_RECONNECT_DELAY_MS = 2000
const MAX_RECONNECT_DELAY_MS = 60000

/**
 * WebRTC connection manager.
 */
export class WebRTCConnectionManager {
  private signalUrl: string
  private token: string
  private deviceId: string
  private targetDeviceId: string

  private ws: WebSocket | null = null
  private pc: RTCPeerConnection | null = null
  private dataChannel: RTCDataChannel | null = null

  private state: ConnectionState = 'disconnected'
  private iceServers: RTCIceServer[]

  // Callbacks
  private onStateChange?: (state: ConnectionState) => void
  private onDataChannelMessage?: (message: string | ArrayBuffer) => void
  private onError?: (error: Error) => void
  private onConnectionFailed?: (error: Error) => void
  private signChallenge: (context: string, ...fields: string[]) => Promise<string>

  // Reconnection
  private shouldReconnect = true
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS
  private reconnectTimer: number | null = null

  // Connection timeout (10s for fast relay fallback)
  private connectionTimeout: number | null = null
  private readonly CONNECTION_TIMEOUT_MS = 10000

  // ICE restart tracking (prevent infinite restart loops)
  private iceRestartAttempted = false

  /**
   * ICE candidates that arrived before `setRemoteDescription()`.
   *
   * `addIceCandidate()` throws `InvalidStateError` while the remote description
   * is unset, and the peer routinely sends candidates before its answer lands.
   * Queue them and flush once the remote description is applied.
   */
  private pendingIceCandidates: RTCIceCandidateInit[] = []

  // Connection request/ack handling
  private connectAckPromise: {
    resolve: (ack: ConnectAckReceivedMessage) => void
    reject: (error: Error) => void
  } | null = null
  private readonly CONNECT_ACK_TIMEOUT_MS = 30000 // 30s timeout for connect-ack

  constructor(config: WebRTCConfig) {
    this.signalUrl = config.signalUrl
    this.token = config.token
    this.deviceId = config.deviceId
    this.targetDeviceId = config.targetDeviceId
    this.iceServers = config.iceServers ?? DEFAULT_ICE_SERVERS
    this.onStateChange = config.onStateChange
    this.onDataChannelMessage = config.onDataChannelMessage
    this.onError = config.onError
    this.onConnectionFailed = config.onConnectionFailed
    this.signChallenge =
      config.signChallenge ??
      (async (context, ...fields) => (await getDeviceIdentity()).sign(context, ...fields))
  }

  /**
   * Connect to signaling server and establish WebRTC connection.
   */
  async connect(): Promise<void> {
    // An explicit connect() request always re-arms reconnection. Without this a
    // single relay fallback (which calls stopReconnection()) permanently killed
    // WebRTC reconnection for the rest of the session.
    this.shouldReconnect = true
    this.cancelReconnect()
    this.setState('connecting')

    try {
      // Check if RTCPeerConnection is available (can be blocked by extensions)
      if (typeof RTCPeerConnection === 'undefined') {
        throw new Error('RTCPeerConnection not available (WebRTC may be blocked)')
      }

      // Connect to signaling server first to receive ICE servers
      const serverIceServers = await this.connectSignaling()

      // Use server-provided ICE servers if available, otherwise use configured/default
      const effectiveIceServers = serverIceServers.length > 0 ? serverIceServers : this.iceServers
      console.log('[WebRTC] Using ICE servers:', effectiveIceServers)

      // Create RTCPeerConnection with effective ICE servers
      this.pc = new RTCPeerConnection({
        iceServers: effectiveIceServers,
      })

      // Set up connection state handler
      this.pc.onconnectionstatechange = () => {
        if (!this.pc) return

        console.log('[WebRTC] Connection state:', this.pc.connectionState)

        switch (this.pc.connectionState) {
          case 'connected':
            this.clearConnectionTimeout()
            this.setState('connected')
            // Reset ICE restart flag and backoff on successful connection
            this.iceRestartAttempted = false
            this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS
            break
          case 'failed':
            this.clearConnectionTimeout()
            this.setState('failed')
            this.notifyConnectionFailed(new Error('WebRTC peer connection failed'))
            this.handleReconnect()
            break
          case 'closed':
            this.clearConnectionTimeout()
            this.setState('closed')
            break
          case 'disconnected':
            this.setState('disconnected')
            break
        }
      }

      // Set up ICE connection state handler for better diagnostics
      this.pc.oniceconnectionstatechange = () => {
        if (!this.pc) return

        console.log('[WebRTC] ICE connection state:', this.pc.iceConnectionState)

        // If ICE specifically fails but connection hasn't failed yet, try ICE restart
        if (this.pc.iceConnectionState === 'failed' && !this.iceRestartAttempted) {
          console.log('[WebRTC] ICE connection failed, attempting ICE restart')
          void this.attemptIceRestart()
        }
      }

      // Set up ICE candidate handler
      this.pc.onicecandidate = (event) => {
        if (event.candidate) {
          // Send ICE candidate to peer via signaling
          const message: ICECandidateMessage = {
            type: 'ice-candidate',
            target_device_id: this.targetDeviceId,
            payload: {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
            },
          }
          try {
            this.sendSignalingMessage(message)
          } catch (error) {
            console.warn('[WebRTC] Could not forward local ICE candidate:', error)
          }
        } else {
          console.log('[WebRTC] ICE gathering complete')
        }
      }

      // Set up incoming DataChannel handler (for answering peer)
      this.pc.ondatachannel = (event) => {
        console.log('[WebRTC] DataChannel received:', event.channel.label)
        this.setupDataChannel(event.channel)
      }

      // Create DataChannel (as the offering peer)
      this.dataChannel = this.pc.createDataChannel('http-proxy')
      this.setupDataChannel(this.dataChannel)

      // Create and send offer
      await this.createAndSendOffer()

      // Start connection timeout (10s)
      this.startConnectionTimeout()
    } catch (error) {
      this.clearConnectionTimeout()
      this.setState('failed')
      const err = error instanceof Error ? error : new Error(String(error))
      // Only treat this as a *WebRTC leg* failure when signaling is actually up;
      // if signaling itself is down, relay fallback cannot work either and the
      // caller should not be told to switch transports.
      if (this.isSignalingOpen()) {
        this.notifyConnectionFailed(err)
      }
      this.onError?.(err)
      throw err
    }
  }

  /**
   * Connect to signaling server only (without starting WebRTC).
   * Use this when WebRTC is unavailable and we're going straight to relay mode.
   */
  async connectSignalingOnly(): Promise<void> {
    this.shouldReconnect = true
    this.cancelReconnect()
    this.setState('connecting')
    try {
      // We don't use ICE servers in signaling-only mode (relay fallback)
      await this.connectSignaling()
      console.log('[WebRTC] Connected to signaling server only (no WebRTC)')
    } catch (error) {
      this.setState('failed')
      const err = error instanceof Error ? error : new Error(String(error))
      this.onError?.(err)
      throw err
    }
  }

  /**
   * Stop WebRTC reconnection without closing the signaling WebSocket.
   * Use this when falling back to relay - we need the signaling connection
   * to send connect-request messages.
   *
   * A later `connect()` re-arms reconnection.
   */
  stopReconnection(): void {
    this.shouldReconnect = false
    this.cancelReconnect()
    this.clearConnectionTimeout()
    this.closePeerConnection()

    // Don't close WebSocket - we still need it for signaling
    console.log('[WebRTC] Stopped reconnection (keeping signaling WebSocket open)')
  }

  /**
   * Disconnect and clean up resources.
   */
  disconnect(): void {
    this.shouldReconnect = false
    this.cancelReconnect()
    this.clearConnectionTimeout()
    this.rejectPendingConnectAck(new Error('Disconnected'))
    this.closePeerConnection()
    this.closeSignalingSocket()

    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS
    this.setState('disconnected')
    console.log('[WebRTC] Disconnected')
  }

  /**
   * Send data over DataChannel.
   */
  sendData(data: string | ArrayBuffer): void {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('DataChannel not open')
    }

    // TypeScript needs explicit handling of union types for send()
    if (typeof data === 'string') {
      this.dataChannel.send(data)
    } else {
      this.dataChannel.send(data)
    }
  }

  /**
   * Get current connection state.
   */
  getState(): ConnectionState {
    return this.state
  }

  /**
   * Get DataChannel state.
   */
  getDataChannelState(): DataChannelState {
    if (!this.dataChannel) return 'none'
    return this.dataChannel.readyState as DataChannelState
  }

  /**
   * Whether the signaling WebSocket is currently usable.
   */
  isSignalingOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /**
   * Send connect-request and wait for acknowledgment.
   *
   * @param preferredTransport Transport preference ("webrtc", "relay", or "auto")
   * @param relaySessionId Relay session ID if using relay transport
   * @returns Promise that resolves with the connect-ack message
   */
  async sendConnectRequest(
    preferredTransport: 'webrtc' | 'relay' | 'auto' = 'auto',
    relaySessionId?: string
  ): Promise<ConnectAckReceivedMessage> {
    if (!this.isSignalingOpen()) {
      throw new Error('WebSocket not connected')
    }

    return new Promise<ConnectAckReceivedMessage>((resolve, reject) => {
      let timeout: number | null = null

      const release = () => {
        if (timeout !== null) {
          clearTimeout(timeout)
          timeout = null
        }
        if (this.connectAckPromise === handlers) {
          this.connectAckPromise = null
        }
      }

      const handlers = {
        resolve: (ack: ConnectAckReceivedMessage) => {
          release()
          resolve(ack)
        },
        reject: (error: Error) => {
          release()
          reject(error)
        },
      }

      this.connectAckPromise = handlers

      timeout = window.setTimeout(() => {
        timeout = null
        handlers.reject(new Error(`Connect-ack timeout (${this.CONNECT_ACK_TIMEOUT_MS}ms)`))
      }, this.CONNECT_ACK_TIMEOUT_MS)

      const message: ConnectRequestMessage = {
        type: 'connect-request',
        target_device_id: this.targetDeviceId,
        preferred_transport: preferredTransport,
        relay_session_id: relaySessionId,
      }

      console.log('[WebRTC] Sending connect-request:', preferredTransport, relaySessionId)

      try {
        this.sendSignalingMessage(message)
      } catch (error) {
        // Without this the 30s timeout kept running against a promise nobody
        // could ever settle.
        handlers.reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * Connect to signaling server via WebSocket.
   * @returns ICE servers from the connected message (empty array if not provided)
   */
  private connectSignaling(): Promise<RTCIceServer[]> {
    return new Promise((resolve, reject) => {
      // Never leak a live socket: a previous attempt may still be OPEN with its
      // handlers attached, and overwriting `this.ws` would leave it running a
      // second, invisible reconnect loop.
      this.closeSignalingSocket()

      // Connect without token in URL (more secure)
      const ws = new WebSocket(this.signalUrl)
      this.ws = ws
      let resolved = false

      ws.onopen = () => {
        console.log('[Signaling] Connected, sending auth message')
        // Send auth message instead of passing token in URL
        ws.send(
          JSON.stringify({
            type: 'auth',
            token: this.token,
            device_id: this.deviceId,
          })
        )
        // Don't resolve yet - wait for "connected" message with ICE servers
      }

      ws.onerror = (event) => {
        console.error('[Signaling] WebSocket error:', event)
        if (!resolved) {
          resolved = true
          reject(new Error('WebSocket connection failed'))
        }
      }

      ws.onclose = () => {
        console.log('[Signaling] WebSocket closed')
        if (!resolved) {
          resolved = true
          reject(new Error('WebSocket closed before connected'))
        }
        // Only the socket we currently own may drive reconnection.
        if (this.ws !== ws) return
        this.ws = null
        this.rejectPendingConnectAck(new Error('Signaling connection closed'))
        this.handleReconnect()
      }

      ws.onmessage = (event) => {
        try {
          const raw: unknown = event.data
          if (typeof raw !== 'string') {
            console.warn('[Signaling] Ignoring non-text message')
            return
          }
          const message = JSON.parse(raw) as ReceivedSignalingMessage

          // Proof of possession. The server answers `auth` with a challenge
          // and will not send `connected` until this device signs it, so a
          // stolen account token alone cannot open a device socket.
          if (message.type === 'challenge') {
            void this.answerChallenge(ws, message)
            return
          }

          // Check for "connected" message to extract ICE servers
          if (message.type === 'connected' && !resolved) {
            resolved = true
            const iceServers: RTCIceServer[] = []

            // Extract ICE servers from the connected message if available
            if (Array.isArray(message.ice_servers)) {
              for (const server of message.ice_servers) {
                if (typeof server === 'object' && 'urls' in server) {
                  iceServers.push(server)
                }
              }
            }

            console.log('[Signaling] Received ICE servers from server:', iceServers.length)
            resolve(iceServers)
          }

          // Process all messages (including the connected one for logging)
          void this.processSignalingMessage(message)
        } catch (error) {
          console.error('[Signaling] Failed to parse message:', error)
        }
      }
    })
  }

  /**
   * Sign the signaling server's challenge and send the auth-response.
   *
   * A failure here is left to close the socket from the server side rather
   * than being papered over: an unsigned connection is not a connection.
   *
   * @param ws Socket the challenge arrived on.
   * @param message The challenge frame.
   */
  private async answerChallenge(ws: WebSocket, message: ChallengeMessage): Promise<void> {
    try {
      const signature = await this.signChallenge(SIGNAL_CONTEXT, this.deviceId, message.challenge)
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'auth-response', signature }))
      }
    } catch (error) {
      console.error('[Signaling] Could not answer the device key challenge:', error)
      this.onError?.(error instanceof Error ? error : new Error(String(error)))
      ws.close()
    }
  }

  /**
   * Create SDP offer and send to target device.
   */
  private async createAndSendOffer(): Promise<void> {
    if (!this.pc) {
      throw new Error('Peer connection not initialized')
    }

    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)

    console.log('[WebRTC] Created SDP offer')

    if (offer.sdp === undefined) {
      throw new Error('Created offer has no SDP')
    }

    // Send offer to target device
    const message: OfferMessage = {
      type: 'offer',
      target_device_id: this.targetDeviceId,
      payload: {
        sdp: offer.sdp,
        type: 'offer',
      },
    }

    this.sendSignalingMessage(message)
  }

  /**
   * Process signaling message from server.
   */
  private async processSignalingMessage(message: ReceivedSignalingMessage): Promise<void> {
    console.log('[Signaling] Received message:', message.type)

    try {
      switch (message.type) {
        case 'connected':
          console.log('[Signaling] Connection confirmed:', message.message)
          break

        case 'offer':
          // Received SDP offer - create answer
          await this.handleOffer(message.payload)
          break

        case 'answer':
          // Received SDP answer
          await this.handleAnswer(message.payload)
          break

        case 'ice-candidate':
          // Received ICE candidate
          await this.handleICECandidate(message.payload)
          break

        case 'error':
          console.error('[Signaling] Error:', message.message)
          this.onError?.(new Error(message.message))
          break

        case 'ack':
          console.log('[Signaling] Ack:', message.message)
          break

        case 'connect-ack-received':
          // Received acknowledgment for connection request
          console.log('[Signaling] Received connect-ack:', message)
          this.connectAckPromise?.resolve(message)
          break

        default:
          console.warn('[Signaling] Unknown message type:', (message as { type: string }).type)
      }
    } catch (error) {
      console.error('[Signaling] Error processing message:', error)
      const err = error instanceof Error ? error : new Error(String(error))
      this.onError?.(err)
    }
  }

  /**
   * Handle received SDP offer.
   */
  private async handleOffer(payload: { sdp: string; type: string }): Promise<void> {
    if (!this.pc) {
      throw new Error('Peer connection not initialized')
    }

    const offer = new RTCSessionDescription({
      sdp: payload.sdp,
      type: payload.type as RTCSdpType,
    })

    await this.pc.setRemoteDescription(offer)
    await this.flushPendingIceCandidates()

    // Create and send answer
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)

    console.log('[WebRTC] Created SDP answer')

    if (answer.sdp === undefined) {
      throw new Error('Created answer has no SDP')
    }

    const message: AnswerMessage = {
      type: 'answer',
      target_device_id: this.targetDeviceId,
      payload: {
        sdp: answer.sdp,
        type: 'answer',
      },
    }

    this.sendSignalingMessage(message)
  }

  /**
   * Handle received SDP answer.
   */
  private async handleAnswer(payload: { sdp: string; type: string }): Promise<void> {
    if (!this.pc) {
      throw new Error('Peer connection not initialized')
    }

    const answer = new RTCSessionDescription({
      sdp: payload.sdp,
      type: payload.type as RTCSdpType,
    })

    await this.pc.setRemoteDescription(answer)
    console.log('[WebRTC] Set remote description (answer)')
    await this.flushPendingIceCandidates()
  }

  /**
   * Handle received ICE candidate.
   *
   * Candidates that arrive before the remote description is set are queued
   * rather than dropped - see `pendingIceCandidates`.
   */
  private async handleICECandidate(payload: {
    candidate: string
    sdpMid: string | null
    sdpMLineIndex: number | null
  }): Promise<void> {
    const init: RTCIceCandidateInit = {
      candidate: payload.candidate,
      sdpMid: payload.sdpMid,
      sdpMLineIndex: payload.sdpMLineIndex,
    }

    if (!this.pc || this.pc.remoteDescription === null) {
      this.pendingIceCandidates.push(init)
      console.log(
        `[WebRTC] Queued early ICE candidate (${this.pendingIceCandidates.length} pending)`
      )
      return
    }

    await this.addIceCandidate(this.pc, init)
  }

  /**
   * Apply every candidate queued before the remote description arrived.
   */
  private async flushPendingIceCandidates(): Promise<void> {
    if (!this.pc || this.pendingIceCandidates.length === 0) {
      return
    }

    const queued = this.pendingIceCandidates
    this.pendingIceCandidates = []
    console.log(`[WebRTC] Flushing ${queued.length} queued ICE candidate(s)`)

    for (const init of queued) {
      await this.addIceCandidate(this.pc, init)
    }
  }

  private async addIceCandidate(pc: RTCPeerConnection, init: RTCIceCandidateInit): Promise<void> {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(init))
      console.log('[WebRTC] Added ICE candidate')
    } catch (error) {
      // Don't throw - a single malformed candidate shouldn't kill the connection.
      console.warn('[WebRTC] Failed to add ICE candidate:', error)
    }
  }

  /**
   * Send message to signaling server.
   */
  private sendSignalingMessage(
    message: OfferMessage | AnswerMessage | ICECandidateMessage | ConnectRequestMessage
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected')
    }

    this.ws.send(JSON.stringify(message))
    console.log('[Signaling] Sent message:', message.type)
  }

  /**
   * Set up DataChannel event handlers.
   */
  private setupDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel

    channel.onopen = () => {
      console.log(`[DataChannel] '${channel.label}' opened`)
    }

    channel.onclose = () => {
      console.log(`[DataChannel] '${channel.label}' closed`)
    }

    channel.onmessage = (event) => {
      const data: unknown = event.data
      if (data instanceof ArrayBuffer) {
        console.log(`[DataChannel] Binary message received: ${data.byteLength} bytes`)
        this.onDataChannelMessage?.(data)
      } else {
        const text = String(data)
        console.log('[DataChannel] Text message received:', text.substring(0, 100))
        this.onDataChannelMessage?.(text)
      }
    }

    channel.onerror = (event) => {
      console.error('[DataChannel] Error:', event)
      this.onError?.(new Error('DataChannel error'))
    }
  }

  /**
   * Update connection state and notify callback.
   */
  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      const oldState = this.state
      this.state = state
      console.log(`[WebRTC] State change: ${oldState} → ${state}`)
      this.onStateChange?.(state)
    }
  }

  /**
   * Report a WebRTC-leg failure. Unlike `setState` this is never de-duplicated.
   */
  private notifyConnectionFailed(error: Error): void {
    this.onConnectionFailed?.(error)
  }

  /**
   * Handle reconnection with exponential backoff.
   */
  private handleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer !== null) {
      return
    }

    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS)

    console.log(`[WebRTC] Attempting reconnect in ${delay}ms...`)

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null

      // Re-check at fire time: a disconnect() at +0.5s must not be resurrected
      // by a timer scheduled at +0s.
      if (!this.shouldReconnect) {
        console.log('[WebRTC] Reconnect cancelled')
        return
      }

      this.cleanupWebRTC()
      this.connect().catch((error: unknown) => {
        console.error('[WebRTC] Reconnect failed:', error)
      })
    }, delay)
  }

  /**
   * Cancel a scheduled reconnect attempt.
   */
  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /**
   * Attempt ICE restart when ICE connection fails.
   * Creates a new offer with iceRestart flag to re-gather candidates.
   */
  private async attemptIceRestart(): Promise<void> {
    if (!this.pc || this.iceRestartAttempted) {
      return
    }

    this.iceRestartAttempted = true

    try {
      console.log('[WebRTC] Creating ICE restart offer')
      const offer = await this.pc.createOffer({ iceRestart: true })
      await this.pc.setLocalDescription(offer)

      if (offer.sdp === undefined) {
        throw new Error('ICE restart offer has no SDP')
      }

      // Send the new offer to peer
      const message: OfferMessage = {
        type: 'offer',
        target_device_id: this.targetDeviceId,
        payload: {
          sdp: offer.sdp,
          type: 'offer',
        },
      }

      this.sendSignalingMessage(message)
      console.log('[WebRTC] ICE restart offer sent')
    } catch (error) {
      console.error('[WebRTC] ICE restart failed:', error)
      // If ICE restart fails, fall back to full reconnection
      this.notifyConnectionFailed(error instanceof Error ? error : new Error(String(error)))
      this.handleReconnect()
    }
  }

  /**
   * Clean up WebRTC resources (PeerConnection, DataChannel) without closing WebSocket.
   */
  private cleanupWebRTC(): void {
    this.clearConnectionTimeout()

    // Reset ICE restart flag for next connection attempt
    this.iceRestartAttempted = false

    this.closePeerConnection()

    console.log('[WebRTC] Cleaned up old WebRTC state')
  }

  /**
   * Close the DataChannel and RTCPeerConnection and drop queued ICE candidates.
   */
  private closePeerConnection(): void {
    this.pendingIceCandidates = []

    if (this.dataChannel) {
      this.dataChannel.close()
      this.dataChannel = null
    }

    if (this.pc) {
      this.pc.close()
      this.pc = null
    }
  }

  /**
   * Close the signaling WebSocket and detach its handlers so it cannot drive
   * state changes or reconnection after we've moved on.
   */
  private closeSignalingSocket(): void {
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

  private rejectPendingConnectAck(error: Error): void {
    this.connectAckPromise?.reject(error)
  }

  /**
   * Start connection timeout (10s).
   * If connection doesn't succeed within timeout, trigger failure and reconnect.
   */
  private startConnectionTimeout(): void {
    this.clearConnectionTimeout()

    this.connectionTimeout = window.setTimeout(() => {
      this.connectionTimeout = null
      console.warn(`[WebRTC] Connection timeout after ${this.CONNECTION_TIMEOUT_MS}ms`)

      if (this.state !== 'connected') {
        const error = new Error('WebRTC connection timeout')
        this.setState('failed')
        this.notifyConnectionFailed(error)
        this.onError?.(error)
        // Previously the timeout stopped here, so nothing ever retried or
        // escalated and relay fallback waited for an unrelated failure.
        this.handleReconnect()
      }
    }, this.CONNECTION_TIMEOUT_MS)

    console.log(`[WebRTC] Started ${this.CONNECTION_TIMEOUT_MS}ms connection timeout`)
  }

  /**
   * Clear connection timeout.
   */
  private clearConnectionTimeout(): void {
    if (this.connectionTimeout !== null) {
      clearTimeout(this.connectionTimeout)
      this.connectionTimeout = null
    }
  }
}
