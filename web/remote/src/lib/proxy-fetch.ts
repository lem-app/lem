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
 * Streaming HTTP proxy over the tunnel transport (protocol v3).
 *
 * `fetch()` resolves as soon as `HTTP_RESPONSE_HEAD` arrives, with a `Response`
 * wrapping a live `ReadableStream` that later chunks feed. That is what makes
 * a `<script>` start executing, an `EventSource` start firing, and model tokens
 * paint as they arrive - v2 delivered a whole response in one frame, so nothing
 * could stream and nothing over ~64 KiB could cross at all.
 */

import type { WebRTCConnectionManager } from './webrtc'
import type { RelayClient } from './relay-client'
import {
  FrameType,
  MAX_BODY_BYTES,
  MAX_CHUNK_BYTES,
  deserializeCancel,
  deserializeChunk,
  deserializeResponseHead,
  serializeCancel,
  serializeRequestChunk,
  serializeRequestHead,
  type HeaderList,
} from './http-frame'
import { LemProxyError, TunnelErrorCode, errorNameForCode } from './tunnel-errors'

/**
 * The response's header pairs exactly as the frame carried them.
 *
 * **`Response`'s `Headers` has the "response" guard, and that guard silently
 * drops `Set-Cookie`.** So the `Response` this class returns cannot be used to
 * find out what the upstream actually sent - it has already lost precisely the
 * header the Service Worker's cookie jar exists to read (spec section 5.6.2).
 * Node's undici does not enforce the guard, so a test reading
 * `response.headers` agrees with the code and every browser disagrees; that
 * exact divergence has cost this area one full implementation already.
 *
 * The pairs therefore travel beside the `Response` rather than inside it. A
 * symbol, not a field: `Response` is a platform object and this is a private
 * side-channel between `HTTPProxy` and `sw-bridge`, not part of its shape.
 */
const RAW_HEADER_PAIRS = Symbol('lem.rawResponseHeaders')

/**
 * Read the unguarded header pairs `HTTPProxy` attached to a response.
 *
 * Returns null for any response this class did not produce, so a caller can
 * fall back to `response.headers` for those.
 */
export function rawResponseHeaders(response: Response): HeaderList | null {
  const carrier = response as Response & { [RAW_HEADER_PAIRS]?: HeaderList }
  return carrier[RAW_HEADER_PAIRS] ?? null
}

/**
 * Attach the frame's pairs to the `Response` built from it.
 *
 * Exported only so a test can build the `Response` a *browser* would have
 * produced - one whose `headers` have already lost `Set-Cookie` to the guard.
 * Node cannot produce that response on its own, so a test that needs one has to
 * construct it, and a test that cannot construct it can only ever assert
 * undici's behaviour instead of the platform's.
 */
export function attachRawHeaders(response: Response, headers: HeaderList): Response {
  Object.defineProperty(response, RAW_HEADER_PAIRS, { value: headers, enumerable: false })
  return response
}

/** No RESPONSE_HEAD within this window fails the fetch. */
export const HEAD_TIMEOUT_MS = 30_000

/**
 * No chunk within this window fails an in-flight stream.
 *
 * Deliberately not a single blanket timer: v2's 30s clock started at send and
 * killed any generation that took longer, however healthy. This one resets on
 * every chunk, so a five-minute model response with a token every two seconds
 * survives while a genuinely stalled stream still fails.
 */
export const CHUNK_IDLE_TIMEOUT_MS = 60_000

/** Bytes tolerated on a torn-down request_id before the peer is misbehaving. */
const POST_CANCEL_DRAIN_BYTES = 512 * 1024

/**
 * One in-flight exchange.
 */
interface PendingExchange {
  resolveResponse: (response: Response) => void
  rejectResponse: (error: Error) => void
  controller: ReadableStreamDefaultController<Uint8Array> | null
  /** Cumulative body bytes; the accumulator of spec section 5.5.1. */
  received: number
  headSettled: boolean
  timer: number | null
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
 * Normalize any `RequestInit` body to bytes.
 *
 * Everything goes through `new Request(...).arrayBuffer()`, so Blob,
 * ArrayBuffer, typed arrays, FormData (with its multipart boundary intact) and
 * URLSearchParams all serialize the way the platform would serialize them. v2
 * stringified anything it did not recognise, which turned a Blob into the
 * literal text "[object Blob]".
 */
async function bodyToBytes(url: string, init: RequestInit | undefined): Promise<Uint8Array> {
  if (init?.body === undefined || init.body === null) {
    return new Uint8Array(0)
  }
  const buffer = await new Request(url, {
    method: init.method ?? 'POST',
    body: init.body,
  }).arrayBuffer()
  return new Uint8Array(buffer)
}

/**
 * Collect `init.headers` into an ordered pair list.
 *
 * Pairs, not an object: an object silently collapses duplicates, which loses
 * every `Set-Cookie` after the first and breaks login for real apps.
 */
function headersToPairs(init: RequestInit | undefined): HeaderList {
  const pairs: HeaderList = []
  const source = init?.headers
  if (!source) return pairs

  if (source instanceof Headers) {
    source.forEach((value, key) => pairs.push([key, value]))
  } else if (Array.isArray(source)) {
    source.forEach(([key, value]) => pairs.push([key, value]))
  } else {
    Object.entries(source).forEach(([key, value]) => pairs.push([key, value]))
  }
  return pairs
}

/**
 * HTTP proxy manager.
 *
 * Manages request/response correlation and provides a fetch()-like API over
 * either the WebRTC DataChannel or the relay WebSocket.
 */
export class HTTPProxy {
  private transport: Transport
  private nextRequestId = 1
  private pending = new Map<number, PendingExchange>()
  /** request_id -> bytes seen since teardown, so late chunks are not buffered. */
  private tombstoned = new Map<number, number>()

  private maxChunkBytes = MAX_CHUNK_BYTES
  private maxBodyBytes = MAX_BODY_BYTES

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
   * Apply limits negotiated in HELLO.
   *
   * Clamped with `min`: a peer may lower what this side will send or accept,
   * never raise it.
   */
  setNegotiatedLimits(peerMaxChunkBytes: number, peerMaxBodyBytes: number): void {
    this.maxChunkBytes = Math.max(1, Math.min(MAX_CHUNK_BYTES, peerMaxChunkBytes))
    this.maxBodyBytes = Math.min(MAX_BODY_BYTES, peerMaxBodyBytes)
  }

  /** Effective per-frame payload limit for this channel. */
  get effectiveMaxChunk(): number {
    return this.maxChunkBytes
  }

  /**
   * Number of requests still awaiting a response. Exposed for tests and
   * diagnostics - a monotonically growing value means responses are being lost.
   */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * Proxy fetch() implementation.
   *
   * Resolves when the response *head* arrives; the body streams in behind it.
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const urlObj = new URL(url)
    const path = urlObj.pathname + urlObj.search
    const method = init?.method ?? 'GET'
    const headers = headersToPairs(init)
    const body = await bodyToBytes(url, init)

    const requestId = this.nextRequestId
    // Wrap at 2^32-1 back to 1; 0 is reserved.
    this.nextRequestId = this.nextRequestId >= 0xffffffff ? 1 : this.nextRequestId + 1

    return new Promise<Response>((resolve, reject) => {
      const exchange: PendingExchange = {
        resolveResponse: resolve,
        rejectResponse: reject,
        controller: null,
        received: 0,
        headSettled: false,
        timer: null,
      }
      this.pending.set(requestId, exchange)
      this.armTimer(requestId, exchange, HEAD_TIMEOUT_MS, 'E_TIMEOUT_HEAD')

      try {
        if (!this.transport.isOpen()) {
          throw new Error('Transport not open')
        }

        this.transport.sendData(
          serializeRequestHead({
            requestId,
            method,
            path,
            headers,
            bodyFollows: body.byteLength > 0,
          })
        )

        for (let offset = 0; offset < body.byteLength; offset += this.maxChunkBytes) {
          const slice = body.subarray(offset, offset + this.maxChunkBytes)
          const isLast = offset + this.maxChunkBytes >= body.byteLength
          this.transport.sendData(serializeRequestChunk(requestId, slice, isLast))
        }

        if (init?.signal) {
          this.bindAbort(requestId, init.signal)
        }
      } catch (error) {
        this.failExchange(
          requestId,
          error instanceof Error ? error : new Error(String(error)),
          false
        )
      }
    })
  }

  /**
   * Route one inbound frame.
   *
   * Returns true when the frame belonged to this proxy.
   */
  handleFrame(buffer: ArrayBuffer): boolean {
    const view = new Uint8Array(buffer)
    if (view.byteLength < 1) return false

    switch (view[0]) {
      case FrameType.HTTP_RESPONSE_HEAD:
        this.handleResponseHead(buffer)
        return true
      case FrameType.HTTP_RESPONSE_CHUNK:
        this.handleResponseChunk(buffer)
        return true
      case FrameType.HTTP_CANCEL:
        this.handleCancel(buffer)
        return true
      default:
        return false
    }
  }

  /**
   * Handle HTTP_RESPONSE_HEAD: resolve the fetch immediately with a streaming
   * body.
   */
  private handleResponseHead(buffer: ArrayBuffer): void {
    let frame
    try {
      frame = deserializeResponseHead(buffer)
    } catch (error) {
      console.error('[ProxyFetch] Malformed response head:', error)
      return
    }

    const exchange = this.pending.get(frame.requestId)
    if (!exchange || exchange.headSettled) {
      if (!this.tombstoned.has(frame.requestId)) {
        console.warn(`[ProxyFetch] No pending request for ID ${frame.requestId}`)
      }
      return
    }

    const headers = new Headers()
    // append, never set: duplicates are the reason the wire carries pairs.
    frame.headers.forEach(([name, value]) => headers.append(name, value))

    exchange.headSettled = true

    if (!frame.bodyFollows) {
      this.clearTimer(exchange)
      this.pending.delete(frame.requestId)
      exchange.resolveResponse(
        attachRawHeaders(new Response(null, { status: frame.statusCode, headers }), frame.headers)
      )
      return
    }

    const stream = new ReadableStream<Uint8Array>({
      // `start` runs synchronously during construction, so the controller is in
      // hand before the Response below is built and therefore before any chunk
      // frame can be routed here. No queue is needed, and one would be dead
      // code pretending to handle an ordering that cannot occur.
      start: (controller) => {
        exchange.controller = controller
      },
      cancel: () => {
        // The consumer walked away: tell the server to stop producing.
        this.sendCancel(frame.requestId, TunnelErrorCode.E_SESSION_CLOSED)
        this.pending.delete(frame.requestId)
        this.tombstone(frame.requestId)
      },
    })

    // The clock now measures inter-chunk silence, not total duration.
    this.armTimer(frame.requestId, exchange, CHUNK_IDLE_TIMEOUT_MS, 'E_TIMEOUT_STREAM')

    exchange.resolveResponse(
      attachRawHeaders(new Response(stream, { status: frame.statusCode, headers }), frame.headers)
    )
  }

  /**
   * Handle HTTP_RESPONSE_CHUNK: enqueue, or fail on the cumulative cap.
   */
  private handleResponseChunk(buffer: ArrayBuffer): void {
    let frame
    try {
      frame = deserializeChunk(buffer, this.maxChunkBytes)
    } catch (error) {
      console.error('[ProxyFetch] Rejected response chunk:', error)
      return
    }

    const drained = this.tombstoned.get(frame.requestId)
    if (drained !== undefined) {
      const seen = drained + frame.payload.byteLength
      this.tombstoned.set(frame.requestId, seen)
      if (frame.final || seen > POST_CANCEL_DRAIN_BYTES) {
        this.tombstoned.delete(frame.requestId)
      }
      return
    }

    const exchange = this.pending.get(frame.requestId)
    if (!exchange) {
      console.warn(`[ProxyFetch] Chunk for unknown request ${frame.requestId}`)
      return
    }

    // THE CHECK, before the enqueue, on the running total (spec 5.5.1).
    if (exchange.received + frame.payload.byteLength > this.maxBodyBytes) {
      // error(), never close(): a closed stream hands the app a truncated body
      // it believes is complete. An errored one rejects the fetch, exactly as
      // an interrupted download does.
      this.failExchange(frame.requestId, new LemProxyError('E_TOO_LARGE'), true)
      this.sendCancel(frame.requestId, TunnelErrorCode.E_TOO_LARGE)
      return
    }

    exchange.received += frame.payload.byteLength

    if (frame.payload.byteLength > 0) {
      exchange.controller?.enqueue(frame.payload)
    }

    if (frame.final) {
      this.clearTimer(exchange)
      exchange.controller?.close()
      this.pending.delete(frame.requestId)
      return
    }

    // Reset the idle clock: this stream is demonstrably alive.
    this.armTimer(frame.requestId, exchange, CHUNK_IDLE_TIMEOUT_MS, 'E_TIMEOUT_STREAM')
  }

  /**
   * Handle an inbound HTTP_CANCEL.
   *
   * Always `controller.error()`, never `close()` - a cancel mid-stream means
   * the body is incomplete, and saying otherwise is silent corruption.
   */
  private handleCancel(buffer: ArrayBuffer): void {
    let frame
    try {
      frame = deserializeCancel(buffer)
    } catch (error) {
      console.error('[ProxyFetch] Malformed cancel:', error)
      return
    }

    const name = errorNameForCode(frame.reasonCode) ?? 'E_INTERNAL'
    this.failExchange(frame.requestId, new LemProxyError(name), true)
  }

  /**
   * Fail one exchange, whether or not its head has been delivered.
   */
  private failExchange(requestId: number, error: Error, tombstone: boolean): void {
    const exchange = this.pending.get(requestId)
    if (!exchange) return

    this.clearTimer(exchange)
    this.pending.delete(requestId)
    if (tombstone) {
      this.tombstone(requestId)
    }

    if (exchange.controller) {
      // The body is already streaming: error it so the reader sees a failure
      // rather than a body that merely stops.
      exchange.controller.error(error)
      return
    }
    if (exchange.headSettled) {
      // A bodyless response was already delivered; nothing left to fail.
      return
    }
    exchange.rejectResponse(error)
  }

  private tombstone(requestId: number): void {
    this.tombstoned.set(requestId, 0)
    // Bounded: the oldest entry goes when the map is full.
    if (this.tombstoned.size > 128) {
      const oldest = this.tombstoned.keys().next()
      if (!oldest.done) this.tombstoned.delete(oldest.value)
    }
  }

  private sendCancel(requestId: number, reasonCode: number): void {
    try {
      if (this.transport.isOpen()) {
        this.transport.sendData(serializeCancel(requestId, reasonCode))
      }
    } catch (error) {
      console.warn('[ProxyFetch] Could not send cancel:', error)
    }
  }

  private bindAbort(requestId: number, signal: AbortSignal): void {
    if (signal.aborted) {
      this.sendCancel(requestId, TunnelErrorCode.E_SESSION_CLOSED)
      this.failExchange(requestId, new LemProxyError('E_SESSION_CLOSED', 'Aborted'), true)
      return
    }
    signal.addEventListener(
      'abort',
      () => {
        this.sendCancel(requestId, TunnelErrorCode.E_SESSION_CLOSED)
        this.failExchange(requestId, new LemProxyError('E_SESSION_CLOSED', 'Aborted'), true)
      },
      { once: true }
    )
  }

  private armTimer(
    requestId: number,
    exchange: PendingExchange,
    delayMs: number,
    code: 'E_TIMEOUT_HEAD' | 'E_TIMEOUT_STREAM'
  ): void {
    this.clearTimer(exchange)
    exchange.timer = window.setTimeout(() => {
      exchange.timer = null
      this.failExchange(requestId, new LemProxyError(code), true)
      this.sendCancel(requestId, TunnelErrorCode[code])
    }, delayMs)
  }

  private clearTimer(exchange: PendingExchange): void {
    if (exchange.timer !== null) {
      clearTimeout(exchange.timer)
      exchange.timer = null
    }
  }

  /**
   * Fail everything outstanding. Called when the transport goes away so the map
   * cannot accumulate resolvers nobody will ever call, and so an open stream is
   * errored rather than left hanging.
   */
  clearPending(): void {
    const ids = [...this.pending.keys()]
    ids.forEach((requestId) => {
      this.failExchange(requestId, new Error('Connection closed'), false)
    })
    this.pending.clear()
    this.tombstoned.clear()
  }
}
