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
  ConnectionState,
  DataChannelState,
  ReceivedSignalingMessage,
  OfferMessage,
  AnswerMessage,
  ICECandidateMessage,
  ConnectRequestMessage,
  ConnectAckReceivedMessage,
} from '../api/types'

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
}

/**
 * Default ICE servers (Google STUN).
 */
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  {
    urls: 'stun:stun.l.google.com:19302',
  },
]

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

  // Reconnection
  private shouldReconnect = true
  private reconnectDelay = 2000
  private maxReconnectDelay = 60000

  // Connection timeout (15s as per spec)
  private connectionTimeout: number | null = null
  private readonly CONNECTION_TIMEOUT_MS = 15000

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
    this.iceServers = config.iceServers || DEFAULT_ICE_SERVERS
    this.onStateChange = config.onStateChange
    this.onDataChannelMessage = config.onDataChannelMessage
    this.onError = config.onError
  }

  /**
   * Connect to signaling server and establish WebRTC connection.
   */
  async connect(): Promise<void> {
    this.setState('connecting')

    try {
      // Check if RTCPeerConnection is available (can be blocked by extensions)
      if (typeof RTCPeerConnection === 'undefined') {
        throw new Error('RTCPeerConnection not available (WebRTC may be blocked)')
      }

      // Create RTCPeerConnection
      this.pc = new RTCPeerConnection({
        iceServers: this.iceServers,
      })

      // Set up connection state handler
      this.pc.onconnectionstatechange = () => {
        if (!this.pc) return

        console.log('[WebRTC] Connection state:', this.pc.connectionState)

        switch (this.pc.connectionState) {
          case 'connected':
            this.clearConnectionTimeout()
            this.setState('connected')
            break
          case 'failed':
            this.clearConnectionTimeout()
            this.setState('failed')
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
          this.sendSignalingMessage(message)
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

      // Connect to signaling server
      await this.connectSignaling()

      // Create and send offer
      await this.createAndSendOffer()

      // Start connection timeout (15s)
      this.startConnectionTimeout()
    } catch (error) {
      this.clearConnectionTimeout()
      this.setState('failed')
      const err = error instanceof Error ? error : new Error(String(error))
      this.onError?.(err)
      throw err
    }
  }

  /**
   * Connect to signaling server only (without starting WebRTC).
   * Use this when WebRTC is unavailable and we're going straight to relay mode.
   */
  async connectSignalingOnly(): Promise<void> {
    this.setState('connecting')
    try {
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
   */
  stopReconnection(): void {
    this.shouldReconnect = false

    // Clear connection timeout
    this.clearConnectionTimeout()

    // Close DataChannel
    if (this.dataChannel) {
      this.dataChannel.close()
      this.dataChannel = null
    }

    // Close peer connection
    if (this.pc) {
      this.pc.close()
      this.pc = null
    }

    // Don't close WebSocket - we still need it for signaling
    console.log('[WebRTC] Stopped reconnection (keeping signaling WebSocket open)')
  }

  /**
   * Disconnect and clean up resources.
   */
  disconnect(): void {
    this.shouldReconnect = false

    // Clear connection timeout
    this.clearConnectionTimeout()

    // Close DataChannel
    if (this.dataChannel) {
      this.dataChannel.close()
      this.dataChannel = null
    }

    // Close peer connection
    if (this.pc) {
      this.pc.close()
      this.pc = null
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected')
    }

    return new Promise<ConnectAckReceivedMessage>((resolve, reject) => {
      // Store promise handlers
      this.connectAckPromise = { resolve, reject }

      // Set timeout
      const timeout = setTimeout(() => {
        if (this.connectAckPromise) {
          this.connectAckPromise.reject(new Error('Connect-ack timeout (30s)'))
          this.connectAckPromise = null
        }
      }, this.CONNECT_ACK_TIMEOUT_MS)

      // Send connect-request
      const message: ConnectRequestMessage = {
        type: 'connect-request',
        target_device_id: this.targetDeviceId,
        preferred_transport: preferredTransport,
        relay_session_id: relaySessionId,
      }

      console.log('[WebRTC] Sending connect-request:', preferredTransport, relaySessionId)
      this.sendSignalingMessage(message)

      // Clear timeout when promise settles
      Promise.race([
        new Promise<ConnectAckReceivedMessage>((res, rej) => {
          if (this.connectAckPromise) {
            const original = this.connectAckPromise
            this.connectAckPromise = {
              resolve: (msg) => {
                clearTimeout(timeout)
                res(msg)
                original.resolve(msg)
              },
              reject: (err) => {
                clearTimeout(timeout)
                rej(err)
                original.reject(err)
              },
            }
          }
        }),
      ])
    })
  }

  /**
   * Connect to signaling server via WebSocket.
   */
  private async connectSignaling(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.signalUrl}?token=${this.token}&device_id=${this.deviceId}`
      this.ws = new WebSocket(wsUrl)

      this.ws.onopen = () => {
        console.log('[Signaling] Connected to signaling server')
        resolve()
      }

      this.ws.onerror = (event) => {
        console.error('[Signaling] WebSocket error:', event)
        reject(new Error('WebSocket connection failed'))
      }

      this.ws.onclose = () => {
        console.log('[Signaling] WebSocket closed')
        this.handleReconnect()
      }

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as ReceivedSignalingMessage
          this.processSignalingMessage(message)
        } catch (error) {
          console.error('[Signaling] Failed to parse message:', error)
        }
      }
    })
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

    // Send offer to target device
    const message: OfferMessage = {
      type: 'offer',
      target_device_id: this.targetDeviceId,
      payload: {
        sdp: offer.sdp!,
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
          if (this.connectAckPromise) {
            this.connectAckPromise.resolve(message)
            this.connectAckPromise = null
          }
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

    // Create and send answer
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)

    console.log('[WebRTC] Created SDP answer')

    const message: AnswerMessage = {
      type: 'answer',
      target_device_id: this.targetDeviceId,
      payload: {
        sdp: answer.sdp!,
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
  }

  /**
   * Handle received ICE candidate.
   */
  private async handleICECandidate(payload: {
    candidate: string
    sdpMid: string | null
    sdpMLineIndex: number | null
  }): Promise<void> {
    if (!this.pc) {
      throw new Error('Peer connection not initialized')
    }

    const candidate = new RTCIceCandidate({
      candidate: payload.candidate,
      sdpMid: payload.sdpMid,
      sdpMLineIndex: payload.sdpMLineIndex,
    })

    await this.pc.addIceCandidate(candidate)
    console.log('[WebRTC] Added ICE candidate')
  }

  /**
   * Send message to signaling server.
   */
  private sendSignalingMessage(message: OfferMessage | AnswerMessage | ICECandidateMessage): void {
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
      const data = event.data
      if (data instanceof ArrayBuffer) {
        console.log(`[DataChannel] Binary message received: ${data.byteLength} bytes`)
        this.onDataChannelMessage?.(data)
      } else {
        console.log('[DataChannel] Text message received:', String(data).substring(0, 100))
        this.onDataChannelMessage?.(String(data))
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
   * Handle reconnection with exponential backoff.
   */
  private handleReconnect(): void {
    if (!this.shouldReconnect) {
      return
    }

    console.log(`[WebRTC] Attempting reconnect in ${this.reconnectDelay}ms...`)

    setTimeout(async () => {
      try {
        // Clean up old WebRTC state first
        this.cleanupWebRTC()

        // Then reconnect
        await this.connect()

        // Reset delay on successful reconnect
        this.reconnectDelay = 2000
      } catch (error) {
        console.error('[WebRTC] Reconnect failed:', error)
      }
    }, this.reconnectDelay)

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay)
  }

  /**
   * Clean up WebRTC resources (PeerConnection, DataChannel) without closing WebSocket.
   */
  private cleanupWebRTC(): void {
    // Clear connection timeout
    this.clearConnectionTimeout()

    // Close DataChannel
    if (this.dataChannel) {
      this.dataChannel.close()
      this.dataChannel = null
    }

    // Close peer connection
    if (this.pc) {
      this.pc.close()
      this.pc = null
    }

    console.log('[WebRTC] Cleaned up old WebRTC state')
  }

  /**
   * Start connection timeout (15s).
   * If connection doesn't succeed within timeout, trigger failure.
   */
  private startConnectionTimeout(): void {
    this.clearConnectionTimeout()

    this.connectionTimeout = window.setTimeout(() => {
      console.warn('[WebRTC] Connection timeout after 15s')

      if (this.state !== 'connected') {
        this.setState('failed')
        this.onError?.(new Error('WebRTC connection timeout'))
      }
    }, this.CONNECTION_TIMEOUT_MS)

    console.log('[WebRTC] Started 15s connection timeout')
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
