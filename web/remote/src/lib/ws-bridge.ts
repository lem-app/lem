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
 * The dashboard's half of the WebSocket shim: `window.__lemWsBridge`.
 *
 * The framed app is same-origin now, so its shim can call straight into this
 * object - no `postMessage`, no serialization on the hot path. The direction
 * matters: the **child reaches out**, the parent never reaches in. Reaching in
 * cannot work, because the synchronous `about:blank` window a parent can touch
 * before load is discarded when the real document commits, and by `iframe.load`
 * the app has already opened its first socket (spec section 3.7).
 *
 * This replaces `websocket-intercept.ts`, which patched `window.WebSocket` in
 * the *dashboard's* realm - the wrong realm entirely, since a framed document
 * has its own - behind a `?client=` flag nothing in the codebase ever set.
 *
 * Everything crossing this boundary is realm-crossing by construction: an
 * `ArrayBuffer` or `Blob` minted in the frame fails `instanceof` here. The
 * bridge therefore hands the frame's data to `ProxiedWebSocket` unchanged and
 * relies on that class's brand checks, and it hands *inbound* binary data back
 * as a plain `ArrayBuffer` so the shim can wrap it in the frame's own `Blob`.
 */

import type { WSProxyManager } from './ws-proxy'

/** Close code for "the shim could not reach the parent bridge" (section 7.2). */
export const WS_CODE_NO_BRIDGE = 4002

/** Callbacks the shim registers for one connection. */
export interface WsBridgeSink {
  open(protocol: string): void
  message(data: string | ArrayBuffer): void
  error(): void
  close(code: number, reason: string, wasClean: boolean): void
}

/** What the shim holds onto for one connection. */
export interface WsBridgeHandle {
  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void
  close(code?: number, reason?: string): void
}

/**
 * The object installed at `window.__lemWsBridge`.
 *
 * The sink is passed *into* `connect` rather than registered afterwards: the
 * ack can arrive in the same task as the connect call, and a registry filled in
 * on the next line would miss the `open` it exists to deliver.
 */
export interface LemWsBridge {
  connect(url: string, protocols: string | string[] | undefined, sink: WsBridgeSink): WsBridgeHandle
}

/** A window that may be carrying the bridge. */
export interface WsBridgeHost {
  __lemWsBridge?: LemWsBridge
}

declare global {
  interface Window {
    /** The bridge the framed app's shim reaches for. Same-origin, by design. */
    __lemWsBridge?: LemWsBridge
  }
}

/** A framed window that has installed the shim's attach hook. */
export interface WsBridgeGuest {
  __lemAttachWsBridge?: (bridge: LemWsBridge) => void
}

/**
 * Build the bridge object over a proxy manager.
 *
 * Exported separately from {@link installWsBridge} so a test can drive it
 * without touching a global.
 */
export function createWsBridge(manager: WSProxyManager): LemWsBridge {
  return {
    connect(url, protocols, sink) {
      const socket = manager.createConnection(url, protocols)

      // The frame decides whether it wants a Blob, in its own realm. Handing a
      // parent-realm Blob across would fail `instanceof Blob` inside the app.
      socket.binaryType = 'arraybuffer'

      socket.onopen = () => {
        sink.open(socket.protocol)
      }
      socket.onmessage = (event: MessageEvent) => {
        const data: unknown = event.data
        if (typeof data === 'string') {
          sink.message(data)
          return
        }
        // binaryType is 'arraybuffer', so this is the only other shape.
        sink.message(data as ArrayBuffer)
      }
      socket.onerror = () => {
        sink.error()
      }
      socket.onclose = (event: CloseEvent) => {
        sink.close(event.code, event.reason, event.wasClean)
      }

      return {
        send(data) {
          socket.send(data)
        },
        close(code, reason) {
          socket.close(code, reason)
        },
      }
    },
  }
}

/**
 * Install the bridge on a window, and return the uninstaller.
 *
 * Called while the proxy manager is created - strictly before any iframe
 * element exists - because the shim looks the bridge up in its constructor and
 * the app's first socket is opened during its boot script.
 */
export function installWsBridge(manager: WSProxyManager, host: WsBridgeHost): () => void {
  const bridge = createWsBridge(manager)
  host.__lemWsBridge = bridge
  return () => {
    if (host.__lemWsBridge === bridge) delete host.__lemWsBridge
  }
}

/**
 * Belt and braces: push the bridge into a framed window on `load`.
 *
 * The shim prefers a bridge handed to it this way over walking `window.parent`,
 * which covers the case where the dashboard is *itself* framed and its parent
 * is somebody else. It is never the primary mechanism - by `load` the app has
 * already opened its first socket - and nothing may depend on it.
 */
export function attachWsBridgeToFrame(frame: HTMLIFrameElement, host: WsBridgeHost): void {
  const bridge = host.__lemWsBridge
  if (bridge === undefined) return
  let guest: WsBridgeGuest | null = null
  try {
    guest = frame.contentWindow as unknown as WsBridgeGuest | null
  } catch {
    // Not same-origin after all; nothing to attach to.
    return
  }
  guest?.__lemAttachWsBridge?.(bridge)
}
