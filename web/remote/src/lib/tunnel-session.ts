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
 * Tunnel protocol v3 session: HELLO negotiation and frame routing.
 *
 * Both transports - the WebRTC DataChannel and the relay WebSocket - carry the
 * same frames, so both run through this one object. Having a single
 * `handleFrame` is not a tidiness point: v2's dispatch existed twice, once per
 * transport, and the two were free to drift.
 *
 * Negotiation (spec section 5.8): each peer sends HELLO as the first frame,
 * and MUST NOT act on any other frame until the peer's HELLO is validated.
 *
 * The realistic mismatch is not a *wrong* HELLO but **no HELLO at all**: a v2
 * server has no such frame and its dispatcher rejects 0x00 outright. So the
 * timeout is the mechanism that detects it; the version check only catches a
 * future v4.
 */

import type { Transport } from './proxy-fetch'
import type { HTTPProxy } from './proxy-fetch'
import type { WSProxyManager } from './ws-proxy'
import {
  FrameType,
  MAX_BODY_BYTES,
  MAX_CHUNK_BYTES,
  PROTOCOL_VERSION,
  deserializeHello,
  serializeHello,
  type HelloFrame,
} from './http-frame'
import { LemProxyError } from './tunnel-errors'

/** No HELLO within this window means the peer speaks v2 or older. */
export const HELLO_TIMEOUT_MS = 2_000

/** Frames tolerated before the peer's HELLO arrives. */
export const MAX_PRE_HELLO_QUEUE = 16

/** Close code for a protocol version mismatch (spec section 7.2). */
export const WS_CODE_PROTOCOL_VERSION = 4001

/** Advertised in HELLO; diagnostics only. */
export const IMPL_NAME = 'lem-web/0.1.0'

/**
 * What the user is told when the far end speaks the old protocol.
 *
 * Worded for someone who has to act on it, not for a log: the fix is updating
 * Lem on the machine being connected to, and no amount of retrying helps.
 */
export const PROTOCOL_MISMATCH_MESSAGE =
  'Your local Lem server speaks an older tunnel protocol (v2). ' +
  'Update Lem on the machine you are connecting to.'

export interface TunnelSessionOptions {
  transport: Transport
  httpProxy: HTTPProxy
  wsProxyManager: WSProxyManager
  onProtocolError?: (error: LemProxyError) => void
  onNegotiated?: (peer: HelloFrame) => void
  closeChannel?: (code: number, reason: string) => void
}

export class TunnelSession {
  private transport: Transport
  private httpProxy: HTTPProxy
  private wsProxyManager: WSProxyManager
  private onProtocolError?: (error: LemProxyError) => void
  private onNegotiated?: (peer: HelloFrame) => void
  private closeChannel?: (code: number, reason: string) => void

  private peerHello: HelloFrame | null = null
  private helloSent = false
  private failed = false
  private queue: ArrayBuffer[] = []
  private timer: number | null = null

  constructor(options: TunnelSessionOptions) {
    this.transport = options.transport
    this.httpProxy = options.httpProxy
    this.wsProxyManager = options.wsProxyManager
    this.onProtocolError = options.onProtocolError
    this.onNegotiated = options.onNegotiated
    this.closeChannel = options.closeChannel
  }

  /** Whether the peer's HELLO has been accepted and traffic may flow. */
  get negotiated(): boolean {
    return this.peerHello !== null
  }

  /** The peer's advertisement, once it has arrived. */
  get peer(): HelloFrame | null {
    return this.peerHello
  }

  /** Point the session at a different transport (relay fallback). */
  setTransport(transport: Transport): void {
    this.transport = transport
  }

  /**
   * Send our HELLO and start the timeout that detects a v2 peer.
   *
   * Called when a channel opens, before anything else is put on it.
   */
  begin(): void {
    this.reset()

    const hello: HelloFrame = {
      protocolVersion: PROTOCOL_VERSION,
      flags: 0,
      maxChunkBytes: MAX_CHUNK_BYTES,
      maxBodyBytes: MAX_BODY_BYTES,
      impl: IMPL_NAME,
    }

    try {
      this.transport.sendData(serializeHello(hello))
      this.helloSent = true
      console.log(`[TunnelSession] Sent HELLO (v${PROTOCOL_VERSION})`)
    } catch (error) {
      console.error('[TunnelSession] Could not send HELLO:', error)
      return
    }

    this.timer = window.setTimeout(() => {
      this.timer = null
      if (this.peerHello) return
      console.error(`[TunnelSession] No HELLO from the peer within ${HELLO_TIMEOUT_MS}ms`)
      this.fail(PROTOCOL_MISMATCH_MESSAGE)
    }, HELLO_TIMEOUT_MS)
  }

  /** Forget negotiation state, for a channel that is being re-opened. */
  reset(): void {
    this.peerHello = null
    this.helloSent = false
    this.failed = false
    this.queue = []
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Whether our own HELLO has been put on the wire. */
  get sentHello(): boolean {
    return this.helloSent
  }

  /**
   * Route one inbound frame.
   */
  handleFrame(buffer: ArrayBuffer): void {
    const view = new Uint8Array(buffer)
    if (view.byteLength < 1) {
      console.warn('[TunnelSession] Dropped empty frame')
      return
    }

    if (view[0] === FrameType.HELLO) {
      this.handleHello(buffer)
      return
    }

    if (this.failed) return

    if (!this.peerHello) {
      // Queue rather than reorder the exchange; a peer that floods here is not
      // merely early.
      if (this.queue.length >= MAX_PRE_HELLO_QUEUE) {
        console.error('[TunnelSession] Peer sent too many frames before HELLO')
        this.fail(PROTOCOL_MISMATCH_MESSAGE)
        return
      }
      this.queue.push(buffer)
      return
    }

    this.route(buffer)
  }

  private handleHello(buffer: ArrayBuffer): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }

    let hello: HelloFrame
    try {
      hello = deserializeHello(buffer)
    } catch (error) {
      console.error('[TunnelSession] Malformed HELLO:', error)
      this.fail('The local Lem server sent a malformed handshake.')
      return
    }

    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      console.error(
        `[TunnelSession] Peer speaks v${hello.protocolVersion}, this dashboard speaks v${PROTOCOL_VERSION}`
      )
      this.fail(
        `Your local Lem server speaks tunnel protocol v${hello.protocolVersion}; ` +
          `this dashboard speaks v${PROTOCOL_VERSION}. Update whichever side is older.`
      )
      return
    }

    this.peerHello = hello
    // Each side enforces its own caps; the effective value is the minimum.
    this.httpProxy.setNegotiatedLimits(hello.maxChunkBytes, hello.maxBodyBytes)
    this.wsProxyManager.setNegotiatedLimits(hello.maxChunkBytes)
    console.log(
      `[TunnelSession] Peer HELLO accepted: v${hello.protocolVersion} ${hello.impl} chunk=${hello.maxChunkBytes}`
    )
    this.onNegotiated?.(hello)

    const queued = this.queue
    this.queue = []
    queued.forEach((frame) => {
      this.route(frame)
    })
  }

  private route(buffer: ArrayBuffer): void {
    const frameType = new Uint8Array(buffer)[0]

    if (frameType === FrameType.HTTP_RESPONSE_V2_RESERVED) {
      // A v2 server's response frame. Diagnosable precisely because 0x02 was
      // reserved rather than reused.
      console.error('[TunnelSession] Received a reserved v2 HTTP_RESPONSE frame (0x02)')
      this.fail(PROTOCOL_MISMATCH_MESSAGE, 'E_PROTO_V2_FRAME')
      return
    }

    if (this.httpProxy.handleFrame(buffer)) return
    if (this.wsProxyManager.handleFrame(buffer)) return

    console.warn(`[TunnelSession] Unknown frame type: 0x${frameType.toString(16)}`)
  }

  private fail(
    message: string,
    code: 'E_PROTO_VERSION' | 'E_PROTO_V2_FRAME' = 'E_PROTO_VERSION'
  ): void {
    if (this.failed) return
    this.failed = true
    this.queue = []

    // No request frames are sent to a peer we cannot speak to.
    this.httpProxy.clearPending()
    this.onProtocolError?.(new LemProxyError(code, message))
    this.closeChannel?.(WS_CODE_PROTOCOL_VERSION, 'protocol version mismatch')
  }
}
