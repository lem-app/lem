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
 * Lem app Service Worker: the same-origin proxy for framed services.
 *
 * A service is viewed at `/app/<deviceId>/<serviceId>/…` on the dashboard's own
 * origin. This worker is scoped to `/app/`, so it controls the iframe document
 * and therefore sees *every* request that document makes - subresources,
 * `fetch`, `import()`, worker scripts, `<img src>`, CSS `url()` - including the
 * root-relative ones that carry no prefix. Nothing else catches all of those:
 * URL rewriting misses runtime-constructed URLs, and patching `fetch` in the
 * frame's realm misses everything the platform loads on the app's behalf.
 *
 * The worker holds **no** tunnel state. It cannot: an `RTCDataChannel` cannot be
 * transferred into a worker, and the browser may kill and restart this script at
 * any moment. Every request is handed to the dashboard page over a `MessagePort`
 * and the page performs it over the tunnel.
 *
 * Two rules are load-bearing and neither is an optimisation:
 *
 * - A cross-origin request from a controlled client is **not** intercepted at
 *   all. The tunnel must never become an open proxy from the user's home
 *   network to arbitrary internet hosts.
 * - A request whose `<deviceId>` is not the active tunnel's device is answered
 *   `409` and **never re-routed**. A stale frame that shows an error is
 *   diagnosable; a stale frame quietly showing another machine's data is not.
 *
 * This file lives in `public/` and is served verbatim at `/lem-app-sw.js`, so it
 * is authored as a checked ES module rather than compiled from `src/`: the URL
 * has to be at the origin root for the `/app/` scope to be claimable, and a
 * build step between the source and the served bytes is a place for the two to
 * disagree. `tsconfig.app.json` type-checks it via `checkJs`.
 */

// -- constants ---------------------------------------------------------------

/** Path prefix the worker is scoped to. */
export const APP_PREFIX = '/app/'

/** Where this script is served. A controlled client may not read it. */
export const SW_SCRIPT_PATH = '/lem-app-sw.js'

/** How long a request waits for a cold-started worker's page to re-init. */
export const BRIDGE_WAIT_MS = 3000

/** Lifetime of a persisted client binding. */
export const BINDING_TTL_MS = 24 * 60 * 60 * 1000

/** CSP the worker substitutes for whatever the upstream sent. */
export const SUBSTITUTED_CSP = "frame-ancestors 'self'; base-uri 'self'"

/**
 * How far into an HTML document the worker will look for the shim's insertion
 * point, and the hard bound on what the injecting transform may buffer.
 */
export const HTML_SNIFF_BYTES = 65536

/** Attribute that marks the injected element, for tests and for humans. */
export const SHIM_MARKER_ATTRIBUTE = 'data-lem-ws-shim'

/**
 * Grammar for `/app/<deviceId>/<serviceId>[/rest]`.
 *
 * Both segments are bounded and restricted to characters that cannot introduce
 * a path traversal or a second path segment, so a device or service id from the
 * URL can be compared and forwarded without further escaping.
 */
export const APP_PATH_RE = /^\/app\/([A-Za-z0-9._-]{1,64})\/([A-Za-z0-9._-]{1,64})(\/.*)?$/

/**
 * The subset of the spec's error taxonomy this worker renders itself.
 *
 * `src/lib/tunnel-errors.ts` holds the full table; a test cross-checks these
 * statuses against it, because a worker in `public/` cannot import from `src/`
 * and two hand-maintained tables are how `FrameType` drifted once already.
 */
export const ERROR_STATUS = {
  E_NO_SESSION: 421,
  E_DEVICE_MISMATCH: 409,
  E_SW_FORBIDDEN: 403,
  E_BRIDGE_UNAVAILABLE: 503,
  E_TUNNEL_DOWN: 503,
  E_SESSION_CLOSED: 410,
  E_TIMEOUT_HEAD: 504,
  E_TIMEOUT_STREAM: 504,
  E_TOO_LARGE: 502,
  E_PROTO_VERSION: 502,
  E_PROTO_V2_FRAME: 502,
  E_PROTO_MALFORMED: 502,
  E_UPSTREAM: 502,
  E_UNKNOWN_SERVICE: 502,
  E_INTERNAL: 500,
}

/**
 * Response headers dropped before the `Response` is constructed.
 *
 * These were written for the app's own origin. An upstream CSP would block the
 * shim the worker injects; an upstream `Strict-Transport-Security` would let a
 * framed app pin the *dashboard's* origin to HTTPS-only in the user's browser,
 * which is a denial of service against Lem itself.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'public-key-pins',
  'public-key-pins-report-only',
  // Dropped because a browser drops it anyway: `Set-Cookie` is a forbidden
  // response-header name, so it cannot survive the `Response` constructor here
  // (section 5.6.2). Removing it explicitly keeps this worker's output honest -
  // and keeps the test suite, whose `Response` does *not* enforce that rule,
  // from showing a header no browser would ever deliver.
  'set-cookie',
  'set-cookie2',
])

/**
 * Cross-realm `ArrayBuffer` test.
 *
 * A structured clone that crossed a `MessagePort` may carry a buffer from
 * another realm, and `instanceof` compares constructor identity, not shape. The
 * brand check does not care which realm minted it. (`instanceof` is right often
 * enough in a browser to hide this until a chunk is silently dropped.)
 *
 * @param {unknown} value
 * @returns {value is ArrayBuffer}
 */
function isArrayBuffer(value) {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]'
}

/**
 * The WebSocket shim, as source, spliced into every framed HTML document.
 *
 * It has to travel as a string: the worker injects it into *another realm's*
 * document, and that realm's `window.WebSocket` is the only one the app can
 * see. The dashboard's own realm was what `websocket-intercept.ts` patched,
 * which is why it never worked.
 *
 * Three properties are load-bearing:
 *
 * - It **buffers** `send()` calls made before the socket opens. socket.io and
 *   most hand-written clients call `send()` in the same turn as the
 *   constructor; v2 threw there, which is the whole of defect #2 in issue #6.
 * - It **never falls back to a native `WebSocket`**. A native socket from this
 *   document would connect from the *remote* browser's own network - the user's
 *   coffee shop, not their home - which is defect #1 wearing a different hat.
 *   No bridge means close code 4002 (section 7.2).
 * - It hands binary data to the bridge unchanged and re-wraps inbound binary in
 *   *this* realm's `Blob`, because `instanceof` across an iframe boundary is
 *   false for a perfectly good object.
 *
 * Contains no backtick and no `</script`; a test asserts both, because either
 * would break the splice or the template that carries it.
 */
export const WS_SHIM_SOURCE = `(function () {
  'use strict';
  if (window.__lemWsShimInstalled) return;
  window.__lemWsShimInstalled = true;

  var NativeWebSocket = window.WebSocket;
  var attached = null;

  // Belt and braces (spec 3.7 step 4): the parent pushes the bridge here on
  // load, which covers a dashboard that is itself framed. Never the primary
  // route - by load the app has already opened its first socket.
  window.__lemAttachWsBridge = function (bridge) {
    if (bridge && typeof bridge.connect === 'function') attached = bridge;
  };

  function findBridge() {
    if (attached !== null) return attached;
    try {
      var host = window.parent;
      if (host && host !== window) {
        var bridge = host.__lemWsBridge;
        if (bridge && typeof bridge.connect === 'function') return bridge;
      }
    } catch (error) {
      // A cross-origin parent throws on property access. Only the attach hook
      // can reach us then, and it has not fired yet.
    }
    return null;
  }

  function resolveUrl(raw) {
    var url = new URL(String(raw), document.baseURI);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    else if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new SyntaxError('The URL scheme must be ws or wss');
    }
    return url.href;
  }

  function sizeOf(data) {
    if (typeof data === 'string') return data.length;
    if (data && typeof data.byteLength === 'number') return data.byteLength;
    if (data && typeof data.size === 'number') return data.size;
    return 0;
  }

  function originOf(href) {
    try {
      var url = new URL(href);
      return url.protocol + '//' + url.host;
    } catch (error) {
      return '';
    }
  }

  class LemWebSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      this.CONNECTING = 0;
      this.OPEN = 1;
      this.CLOSING = 2;
      this.CLOSED = 3;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this.binaryType = 'blob';
      this.extensions = '';
      this.protocol = '';
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.url = resolveUrl(url);

      this._pending = [];
      this._handle = null;

      var self = this;
      var bridge = findBridge();
      if (bridge === null) {
        setTimeout(function () {
          self._shutdown(4002, 'Lem app bridge unavailable', false, true);
        }, 0);
        return;
      }

      this._handle = bridge.connect(this.url, protocols, {
        open: function (negotiated) {
          self._opened(negotiated);
        },
        message: function (data) {
          self._received(data);
        },
        error: function () {
          self._fire('error', new Event('error'));
        },
        close: function (code, reason, wasClean) {
          self._shutdown(code, reason, wasClean, false);
        },
      });
    }

    send(data) {
      if (this.readyState === 0) {
        this._pending.push(data);
        this.bufferedAmount += sizeOf(data);
        return;
      }
      if (this.readyState !== 1) {
        throw new DOMException(
          'WebSocket is already in CLOSING or CLOSED state',
          'InvalidStateError'
        );
      }
      if (this._handle !== null) this._handle.send(data);
    }

    close(code, reason) {
      if (this.readyState === 2 || this.readyState === 3) return;
      this.readyState = 2;
      if (this._handle !== null) {
        this._handle.close(code, reason);
        return;
      }
      this._shutdown(code || 1000, reason || '', true, false);
    }

    _opened(negotiated) {
      if (this.readyState !== 0) return;
      this.protocol = negotiated || '';
      this.readyState = 1;
      this._fire('open', new Event('open'));
      var pending = this._pending;
      this._pending = [];
      this.bufferedAmount = 0;
      for (var index = 0; index < pending.length; index += 1) {
        if (this._handle !== null) this._handle.send(pending[index]);
      }
    }

    _received(data) {
      var payload = data;
      if (typeof data !== 'string' && this.binaryType !== 'arraybuffer') {
        payload = new Blob([data]);
      }
      this._fire(
        'message',
        new MessageEvent('message', { data: payload, origin: originOf(this.url) })
      );
    }

    _shutdown(code, reason, wasClean, alsoError) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this._pending = [];
      this.bufferedAmount = 0;
      if (alsoError) this._fire('error', new Event('error'));
      this._fire(
        'close',
        new CloseEvent('close', {
          code: code || 1006,
          reason: reason || '',
          wasClean: Boolean(wasClean),
        })
      );
    }

    _fire(type, event) {
      var handler = this['on' + type];
      if (typeof handler === 'function') handler.call(this, event);
      this.dispatchEvent(event);
    }
  }

  LemWebSocket.CONNECTING = NativeWebSocket ? NativeWebSocket.CONNECTING : 0;
  LemWebSocket.OPEN = NativeWebSocket ? NativeWebSocket.OPEN : 1;
  LemWebSocket.CLOSING = NativeWebSocket ? NativeWebSocket.CLOSING : 2;
  LemWebSocket.CLOSED = NativeWebSocket ? NativeWebSocket.CLOSED : 3;

  window.WebSocket = LemWebSocket;
})();`

/** Statuses that must not carry a body (RFC 9110). */
const BODYLESS_STATUSES = new Set([101, 103, 204, 205, 304])

/** Hosts an upstream `Location` may name that are really *the far machine*. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

// -- types -------------------------------------------------------------------

/** @typedef {{ deviceId: string, serviceId: string }} Binding */
/** @typedef {{ deviceId: string, serviceId: string, expiresAt: number }} StoredBinding */

/**
 * @typedef {object} BindingStore
 * @property {(clientId: string) => Promise<StoredBinding | null>} get
 * @property {(clientId: string, binding: StoredBinding) => Promise<void>} put
 */

/**
 * @typedef {object} SwClient
 * @property {string} id
 * @property {string} url
 * @property {(message: unknown) => void} postMessage
 */

/**
 * @typedef {object} SwClients
 * @property {(id: string) => Promise<SwClient | undefined>} get
 * @property {(options?: { includeUncontrolled?: boolean, type?: string }) => Promise<SwClient[]>} matchAll
 */

/**
 * @typedef {object} SwFetchEvent
 * @property {Request} request
 * @property {string} [clientId]
 * @property {string} [resultingClientId]
 * @property {(response: Response | Promise<Response>) => void} respondWith
 */

// -- pure helpers ------------------------------------------------------------

/**
 * Split an `/app/` path into its parts.
 *
 * @param {string} pathname
 * @returns {{ deviceId: string, serviceId: string, path: string } | null}
 */
export function parseAppPath(pathname) {
  const match = APP_PATH_RE.exec(pathname)
  if (match === null) return null
  // `.` is in the character class, so `.` and `..` match the grammar. A browser
  // normalises those away before a request is issued, but the worker also reads
  // paths out of referrers and stored records, and a segment that means
  // "somewhere else" must never become a device or service id.
  if (isDotSegment(match[1]) || isDotSegment(match[2])) return null
  return { deviceId: match[1], serviceId: match[2], path: match[3] || '/' }
}

/**
 * @param {string} segment
 * @returns {boolean}
 */
function isDotSegment(segment) {
  return segment === '.' || segment === '..'
}

/**
 * Read a `{deviceId, serviceId}` out of any same-origin `/app/` URL.
 *
 * Used for the referrer (step 2) and for `client.url` (step 3). Both are URLs
 * of documents *inside* a service session, so both carry the full prefix.
 *
 * @param {string | null | undefined} raw
 * @param {string} origin
 * @returns {Binding | null}
 */
export function bindingFromUrl(raw, origin) {
  // A Service Worker reports "no referrer" as either the empty string or the
  // literal `about:client`, depending on the browser and the request.
  if (!raw || raw === 'about:client') return null
  let url
  try {
    url = new URL(raw, origin)
  } catch {
    return null
  }
  if (url.origin !== origin) return null
  const parsed = parseAppPath(url.pathname)
  if (parsed === null) return null
  return { deviceId: parsed.deviceId, serviceId: parsed.serviceId }
}

/**
 * Build an RFC 7807 problem detail response, the same shape the local server
 * already uses for its own errors.
 *
 * @param {keyof typeof ERROR_STATUS} code
 * @param {string} detail
 * @returns {Response}
 */
export function problemResponse(code, detail) {
  const status = ERROR_STATUS[code]
  const body = JSON.stringify({
    type: `https://lem.gg/errors/${code.toLowerCase().replace(/_/g, '-')}`,
    title: code,
    status,
    detail,
    code,
  })
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/problem+json',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': SUBSTITUTED_CSP,
    },
  })
}

/**
 * Re-prefix an upstream `Location` so a redirect stays inside the frame.
 *
 * Carries the **request's** device segment, never the active one: the answer to
 * a request belongs to the device that request named, and substituting the
 * active device here would reintroduce exactly the silent re-routing the
 * `409` exists to prevent.
 *
 * Root-relative paths and absolute loopback URLs are rewritten - a loopback
 * absolute URL is *the far machine's* address, and handing it to the remote
 * browser verbatim is defect #1 of the tracking issue in miniature. Anything
 * else (a real external origin) passes through untouched.
 *
 * @param {string} location Raw upstream Location header
 * @param {string} deviceId Device segment of the request being answered
 * @param {string} serviceId Service segment of the request being answered
 * @param {string} upstreamPath Path the request was made to, for relative refs
 * @returns {string}
 */
export function rewriteLocation(location, deviceId, serviceId, upstreamPath) {
  const prefix = `${APP_PREFIX}${deviceId}/${serviceId}`
  const trimmed = location.trim()
  if (trimmed === '') return location

  // Protocol-relative (`//host/path`) names another origin; leave it alone.
  if (trimmed.startsWith('//')) return location

  if (trimmed.startsWith('/')) return prefix + trimmed

  let absolute
  try {
    absolute = new URL(trimmed)
  } catch {
    // A relative reference: resolve it against the upstream path we asked for,
    // then re-prefix the result.
    try {
      const resolved = new URL(trimmed, `http://upstream.invalid${upstreamPath}`)
      return prefix + resolved.pathname + resolved.search + resolved.hash
    } catch {
      return location
    }
  }

  if (LOOPBACK_HOSTS.has(absolute.hostname)) {
    return prefix + absolute.pathname + absolute.search + absolute.hash
  }
  return location
}

// -- shim injection ----------------------------------------------------------

const SPACE_BYTES = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20])

/**
 * @param {Uint8Array} bytes
 * @param {number} index
 * @returns {number} the byte at `index`, ASCII-lowercased
 */
function lowerAt(bytes, index) {
  const byte = bytes[index]
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte
}

/**
 * Case-insensitive ASCII compare at an offset.
 *
 * Deliberately byte-wise rather than `TextDecoder`-per-chunk: decoding each
 * chunk independently turns a multi-byte UTF-8 sequence split across a chunk
 * boundary into replacement characters *inside the document*.
 *
 * @param {Uint8Array} bytes
 * @param {number} index
 * @param {string} ascii Lowercase ASCII needle
 * @returns {boolean}
 */
function matchesAt(bytes, index, ascii) {
  if (index < 0 || index + ascii.length > bytes.length) return false
  for (let offset = 0; offset < ascii.length; offset += 1) {
    if (lowerAt(bytes, index + offset) !== ascii.charCodeAt(offset)) return false
  }
  return true
}

/**
 * @param {Uint8Array} bytes
 * @param {string} ascii
 * @param {number} from
 * @returns {number} index of the first match, or -1
 */
function indexOfAscii(bytes, ascii, from) {
  for (let index = from; index + ascii.length <= bytes.length; index += 1) {
    if (matchesAt(bytes, index, ascii)) return index
  }
  return -1
}

/**
 * Is `<name` starting at `index` a real start tag, rather than `<header`?
 *
 * @param {Uint8Array} bytes
 * @param {number} index Index of the `<`
 * @param {string} name Lowercase tag name
 * @returns {boolean}
 */
function isStartTag(bytes, index, name) {
  if (!matchesAt(bytes, index + 1, name)) return false
  const after = bytes[index + 1 + name.length]
  return after === 0x3e || after === 0x2f || SPACE_BYTES.has(after)
}

/**
 * Does a `<` at `index` open a markup construct at all?
 *
 * The HTML tokenizer's tag-open state: a `<` followed by an ASCII letter, `/`,
 * `!` or `?` starts something; anything else (`a < b` in prose) is just text.
 * Distinguishing them matters because the scanner skips *over* a construct once
 * it recognises one, and skipping over ordinary text would step past markup.
 *
 * @param {Uint8Array} bytes
 * @param {number} index Index of the `<`
 * @returns {boolean}
 */
function isMarkupOpen(bytes, index) {
  const next = lowerAt(bytes, index + 1)
  if (next === undefined) return false
  if (next >= 0x61 && next <= 0x7a) return true
  return next === 0x2f || next === 0x21 || next === 0x3f
}

/**
 * End of a start tag, respecting quoted attribute values.
 *
 * @param {Uint8Array} bytes
 * @param {number} start Index of the `<`
 * @returns {number} index just past the `>`, or -1 if it has not arrived
 */
function endOfStartTag(bytes, start) {
  let quote = 0
  for (let index = start; index < bytes.length; index += 1) {
    const byte = bytes[index]
    if (quote !== 0) {
      if (byte === quote) quote = 0
      continue
    }
    if (byte === 0x22 || byte === 0x27) {
      quote = byte
      continue
    }
    if (byte === 0x3e) return index + 1
  }
  return -1
}

/**
 * Skip the BOM, an XML declaration, comments, the doctype and whitespace.
 *
 * Getting this wrong is not cosmetic: splicing a `<script>` *before* a doctype
 * pushes the document into quirks mode, which changes how the whole app lays
 * out. So a truncated preamble waits for more bytes rather than guessing.
 *
 * @param {Uint8Array} bytes
 * @param {boolean} exhausted No more bytes are coming (or the window is full)
 * @returns {number} offset just past the preamble, or -1 if undecidable
 */
function endOfPreamble(bytes, exhausted) {
  let index = 0
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) index = 3

  for (;;) {
    while (index < bytes.length && SPACE_BYTES.has(bytes[index])) index += 1

    // `<!doctype` is the longest thing that has to be recognised whole; without
    // this the tail of a chunk that happens to end at `<` decides "no preamble"
    // and the doctype lands after the shim.
    if (!exhausted && index + 9 > bytes.length) return -1

    if (matchesAt(bytes, index, '<?')) {
      const end = indexOfAscii(bytes, '?>', index + 2)
      if (end === -1) return -1
      index = end + 2
      continue
    }
    if (matchesAt(bytes, index, '<!--')) {
      const end = indexOfAscii(bytes, '-->', index + 4)
      if (end === -1) return -1
      index = end + 3
      continue
    }
    if (matchesAt(bytes, index, '<!')) {
      const end = endOfStartTag(bytes, index)
      if (end === -1) return -1
      index = end
      continue
    }
    return index
  }
}

/**
 * Where the shim goes in this document.
 *
 * `<head>`'s first child when there is a `<head>`; immediately after the
 * preamble otherwise, which is still ahead of the first `<script>` or `<body>`
 * (the parser fosters a pre-`<html>` script into the head it synthesises).
 *
 * **Two invariants, and the second was learned the hard way.**
 *
 * 1. *Never scan into a tag's attribute region.* An earlier tag whose attribute
 *    value contains the bytes `<head…>` - a `data-*` holding example markup, a
 *    JSON blob, user content - is not a `<head>`. A scanner that advances one
 *    byte at a time past `<html …>` never leaves that tag, reads the fake match
 *    as real, and splices the shim **inside the quotes**. The document is then
 *    corrupt, the shim is not a script, and `window.WebSocket` stays the native
 *    one - which is issue #6's defect #1 reappearing silently. So a recognised
 *    markup construct is skipped whole, quote-aware, never walked into.
 *
 * 2. *A decidable preamble means a safe answer always exists.* Inserting at the
 *    end of the preamble is ordering-correct unconditionally: it is after the
 *    doctype (so the document stays out of quirks mode) and before every tag.
 *    So anything undecidable *after* the preamble - an unterminated tag or
 *    comment at the end of the sniff window - falls back to that rather than
 *    guessing a position. `skip` is reserved for the one case where no position
 *    is safe: a preamble that cannot be delimited, where the shim might land in
 *    front of the doctype.
 *
 * @param {Uint8Array} bytes Everything buffered so far
 * @param {boolean} exhausted No more bytes are coming, or the sniff window is full
 * @returns {{ kind: 'insert', at: number } | { kind: 'wait' } | { kind: 'skip' }}
 */
export function findShimInsertionPoint(bytes, exhausted) {
  const preamble = endOfPreamble(bytes, exhausted)
  // The only unsafe case: we cannot tell where the doctype ends, so we cannot
  // tell whether any offset is in front of it.
  if (preamble === -1) return exhausted ? { kind: 'skip' } : { kind: 'wait' }

  /** Safe fallback for anything we run out of bytes to decide (invariant 2). */
  const undecided = exhausted
    ? /** @type {{ kind: 'insert', at: number }} */ ({ kind: 'insert', at: preamble })
    : /** @type {{ kind: 'wait' }} */ ({ kind: 'wait' })

  let index = preamble
  while (index < bytes.length) {
    if (bytes[index] !== 0x3c) {
      index += 1
      continue
    }

    if (matchesAt(bytes, index, '<!--')) {
      const end = indexOfAscii(bytes, '-->', index + 4)
      if (end === -1) return undecided
      index = end + 3
      continue
    }

    // `<scr` at the end of a chunk must not be read as "not a script", and
    // `<!-` must not be read as "not a comment". `<script` plus one boundary
    // byte is the longest lookahead any decision below needs.
    if (!exhausted && bytes.length - index < 8) return { kind: 'wait' }

    if (isStartTag(bytes, index, 'head')) {
      const end = endOfStartTag(bytes, index)
      if (end === -1) return undecided
      return { kind: 'insert', at: end }
    }
    if (isStartTag(bytes, index, 'script') || isStartTag(bytes, index, 'body')) {
      return { kind: 'insert', at: preamble }
    }

    if (!isMarkupOpen(bytes, index)) {
      // A bare `<` in prose. Stepping over the whole "tag" here would run to
      // some later `>` and could step past the real `<head>`.
      index += 1
      continue
    }

    // Invariant 1: skip the construct whole, attribute values included.
    const end = endOfStartTag(bytes, index)
    if (end === -1) return undecided
    index = end
  }

  if (!exhausted) return { kind: 'wait' }
  return { kind: 'insert', at: preamble }
}

/**
 * @param {Uint8Array} left
 * @param {Uint8Array<ArrayBufferLike>} right
 * @returns {Uint8Array<ArrayBuffer>}
 */
function concatBytes(left, right) {
  // Always a fresh buffer: `right` may be a view onto a pooled or shared one
  // the producer still owns, and this survives across chunks.
  const out = new Uint8Array(left.byteLength + right.byteLength)
  out.set(left, 0)
  out.set(right, left.byteLength)
  return out
}

/**
 * A `TransformStream` that splices the shim into an HTML byte stream.
 *
 * It emits **nothing** downstream until the insertion point is settled: a shim
 * spliced after bytes the browser has already begun parsing is not a shim, it
 * is a race. `HTML_SNIFF_BYTES` bounds both the search and the memory this may
 * hold before it gives up and forwards the document untouched.
 *
 * @param {() => void} [onSkipped] Called when no insertion point was found
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createShimInjector(onSkipped) {
  const injection = new TextEncoder().encode(
    `<script ${SHIM_MARKER_ATTRIBUTE}="1">${WS_SHIM_SOURCE}</` + `script>`
  )
  let held = new Uint8Array(0)
  let settled = false

  /**
   * @param {TransformStreamDefaultController<Uint8Array>} controller
   * @param {boolean} exhausted
   */
  const decide = (controller, exhausted) => {
    const result = findShimInsertionPoint(held, exhausted)
    if (result.kind === 'wait') return
    settled = true
    if (result.kind === 'skip') {
      if (onSkipped) onSkipped()
      controller.enqueue(held)
    } else {
      controller.enqueue(held.subarray(0, result.at))
      controller.enqueue(injection)
      controller.enqueue(held.subarray(result.at))
    }
    held = new Uint8Array(0)
  }

  return new TransformStream({
    transform: (chunk, controller) => {
      if (settled) {
        controller.enqueue(chunk)
        return
      }
      held = concatBytes(held, chunk)
      decide(controller, held.byteLength >= HTML_SNIFF_BYTES)
    },
    flush: (controller) => {
      if (settled) return
      decide(controller, true)
    },
  })
}

/**
 * Should this response have the shim spliced into it?
 *
 * Navigations only, and only real HTML. A subresource fetch that happens to
 * return HTML is not a document, and injecting into it would corrupt it.
 *
 * @param {boolean} isNavigation
 * @param {Headers} headers
 * @returns {boolean}
 */
export function shouldInjectShim(isNavigation, headers) {
  if (!isNavigation) return false
  const type = (headers.get('content-type') ?? '').trim().toLowerCase()
  return type === 'text/html' || type.startsWith('text/html;') || type.startsWith('text/html ')
}

// -- cookies -----------------------------------------------------------------
//
// The worker keeps its **own** cookie jar (spec section 5.6.2). The browser's
// cookie store is never involved, in either direction, and cannot be:
//
// - `Set-Cookie` is a *forbidden response-header name*, so the `Response` this
//   worker synthesises cannot carry one - the `Headers` "response" guard drops
//   it silently - and *parse and store response `Set-Cookie` headers* is only
//   reached from *HTTP-network-or-cache fetch*, which a worker-supplied
//   response never enters.
// - Symmetrically, `Cookie` is appended to a request *after* *handle fetch*, so
//   `event.request.headers` never contains one. The jar has to supply it.
//
// So the jar reads `Set-Cookie` off the tunnel response frame, stores it under
// `(deviceId, serviceId)`, and writes `Cookie` into the header pairs handed to
// the tunnel. Nothing here ever touches `document.cookie` or a `Headers` object
// that would guard these names.
//
// The partition *is* the key. That is what makes this stronger than the
// `Path`-rewrite it replaces: `HttpOnly` is real because the frame's JS has no
// access to the jar at all, one service cannot read another's cookies by
// walking a path, and no `Path` is ever rewritten - so the `__Host-` rule that
// pins `Path=/` is satisfied rather than fought.

/** Cookies kept per `(deviceId, serviceId)` partition before the oldest go. */
export const MAX_COOKIES_PER_PARTITION = 50

/** Bound on the drop log. Diagnosis needs the recent ones, not all of them. */
export const MAX_COOKIE_DROPS = 32

/** Hosts a `Secure` cookie may be accepted on without HTTPS. */
const TRUSTWORTHY_LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * @typedef {object} StoredCookie
 * @property {string} name
 * @property {string} value
 * @property {string} path Upstream path scope; never rewritten.
 * @property {number | null} expiresAt Epoch ms, or null for a session cookie.
 * @property {boolean} secure
 * @property {boolean} httpOnly
 * @property {'strict' | 'lax' | 'none' | null} sameSite
 * @property {number} createdAt Tie-breaker for the `Cookie` header's order.
 */

/**
 * @typedef {object} CookieStore
 * @property {(key: string) => Promise<StoredCookie[] | null>} get
 * @property {(key: string, cookies: StoredCookie[]) => Promise<void>} put
 */

/** @typedef {{ name: string, reason: string, raw: string }} CookieDrop */

/**
 * @typedef {object} CookieReport
 * @property {string[]} stored Names accepted into the jar.
 * @property {string[]} removed Names deleted by an expiry or `Max-Age=0`.
 * @property {CookieDrop[]} dropped Refusals, with the reason for each.
 */

/**
 * Is this origin one a `Secure` cookie may be accepted on?
 *
 * The platform's own "potentially trustworthy origin" rule, not a Lem-specific
 * dev switch: HTTPS anywhere, or a loopback host. Production serves the
 * dashboard over HTTPS and is therefore unaffected by the loopback clause -
 * which is the point. A build flag or an env var here would be a dev
 * convenience that silently weakened production; keying off the actual origin
 * cannot be, because the origin *is* what the rule is about.
 *
 * A plain-HTTP dashboard on a LAN address is neither, so it refuses `Secure`
 * cookies and says so. That is the same answer a browser gives.
 *
 * @param {string} origin
 * @returns {boolean}
 */
export function isTrustworthyOrigin(origin) {
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol === 'https:' || url.protocol === 'wss:') return true
  return TRUSTWORTHY_LOOPBACK.has(url.hostname)
}

/**
 * The prefix a cookie name carries, matched **case-insensitively**.
 *
 * RFC 6265bis section 4.1.3 describes the prefixes from the *server's* point of
 * view and says the match is case-sensitive. The requirement that binds an
 * implementation is in section 5.4 and the storage model of section 5.7, and
 * there it is case-insensitive (`MUST`) - deliberately, so a case-insensitive
 * server cannot be tricked into accepting `__SECURE-` as an unprefixed name.
 *
 * **tough-cookie matches case-sensitively**, and via jsdom it is this
 * repository's only cookie oracle, so a `__HOST-`-cased cookie would pass a
 * suite written against it and fail in a real browser. This matches the way a
 * user agent must, not the way the oracle does.
 *
 * @param {string} name
 * @returns {'__host-' | '__secure-' | null}
 */
export function cookiePrefixOf(name) {
  const lower = name.toLowerCase()
  if (lower.startsWith('__host-')) return '__host-'
  if (lower.startsWith('__secure-')) return '__secure-'
  return null
}

/**
 * RFC 6265 section 5.1.4 default-path: the request path's directory.
 *
 * @param {string} requestPath Path only, no query
 * @returns {string}
 */
export function defaultCookiePath(requestPath) {
  if (!requestPath.startsWith('/')) return '/'
  const lastSlash = requestPath.lastIndexOf('/')
  if (lastSlash === 0) return '/'
  return requestPath.slice(0, lastSlash)
}

/**
 * RFC 6265 section 5.1.4 path-match.
 *
 * @param {string} requestPath
 * @param {string} cookiePath
 * @returns {boolean}
 */
export function cookiePathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  if (cookiePath.endsWith('/')) return true
  return requestPath.charAt(cookiePath.length) === '/'
}

/**
 * Reject anything that could break out of the header it will be written into.
 *
 * The jar's output is concatenated into a `Cookie` header and serialised into a
 * tunnel frame by hand. A CR, LF or NUL smuggled through an upstream
 * `Set-Cookie` would be header injection on the far side, so it is refused at
 * the point of parsing rather than escaped later.
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasControlCharacters(text) {
  return /[\u0000-\u001f\u007f]/.test(text)
}

/**
 * Parse one `Set-Cookie` value (RFC 6265 section 5.2).
 *
 * Returns the cookie, or the reason it is unusable. Never throws and never
 * returns silently: a refused cookie that says nothing is the failure mode
 * section 5.6.2 note 3 records, and it has cost this area two review rounds.
 *
 * @param {string} raw
 * @param {object} context
 * @param {string} context.requestPath Path the request was made to, no query
 * @param {number} context.now
 * @param {boolean} context.secureOrigin
 * @returns {{ cookie: StoredCookie } | { reason: string, name: string }}
 */
export function parseSetCookie(raw, context) {
  const [pair, ...attributeParts] = raw.split(';')
  const equals = pair.indexOf('=')
  if (equals < 0) return { reason: 'no-name-value-pair', name: '' }

  const name = pair.slice(0, equals).trim()
  const value = pair.slice(equals + 1).trim()
  if (name === '') return { reason: 'empty-name', name: '' }
  if (hasControlCharacters(name) || hasControlCharacters(value)) {
    return { reason: 'control-character', name }
  }

  /** @type {string | null} */
  let domain = null
  /** @type {string | null} */
  let path = null
  /** @type {number | null} */
  let expires = null
  /** @type {number | null} */
  let maxAge = null
  let secure = false
  let httpOnly = false
  /** @type {'strict' | 'lax' | 'none' | null} */
  let sameSite = null

  for (const part of attributeParts) {
    const split = part.indexOf('=')
    const attribute = (split < 0 ? part : part.slice(0, split)).trim().toLowerCase()
    const attributeValue = split < 0 ? '' : part.slice(split + 1).trim()
    switch (attribute) {
      case 'domain':
        // Recorded for the `__Host-` rule below and for the drop report. It has
        // no scoping effect: see the jar's note on Domain.
        domain = attributeValue.replace(/^\./, '')
        break
      case 'path':
        // A Path that is not absolute is ignored, and the default-path applies.
        if (attributeValue.startsWith('/')) path = attributeValue
        break
      case 'expires': {
        const parsed = Date.parse(attributeValue)
        if (!Number.isNaN(parsed)) expires = parsed
        break
      }
      case 'max-age': {
        // Max-Age wins over Expires (RFC 6265 section 5.3 step 3).
        if (/^-?\d+$/.test(attributeValue)) maxAge = Number(attributeValue)
        break
      }
      case 'secure':
        secure = true
        break
      case 'httponly':
        httpOnly = true
        break
      case 'samesite': {
        const lower = attributeValue.toLowerCase()
        if (lower === 'strict' || lower === 'lax' || lower === 'none') sameSite = lower
        break
      }
      default:
        break
    }
  }

  const prefix = cookiePrefixOf(name)
  if (prefix !== null && !secure) return { reason: `${prefix}needs-secure`, name }
  if (prefix === '__host-') {
    if (domain !== null) return { reason: '__host-forbids-domain', name }
    if (path !== null && path !== '/') return { reason: '__host-needs-root-path', name }
  }

  // A `Secure` cookie is refused on an origin that is not potentially
  // trustworthy - the same answer a browser gives, and the reason the loopback
  // clause above is the platform's rule rather than a Lem dev switch.
  if (secure && !context.secureOrigin) return { reason: 'insecure-origin', name }

  /** @type {number | null} */
  let expiresAt = null
  if (maxAge !== null) {
    expiresAt = maxAge <= 0 ? 0 : context.now + maxAge * 1000
  } else if (expires !== null) {
    expiresAt = expires
  }

  return {
    cookie: {
      name,
      value,
      // `__host-` forces `/`; everything else keeps what upstream said, or the
      // request's default-path. No path is ever *rewritten* - the partition is
      // the key, so there is nothing for a rewrite to buy.
      path: prefix === '__host-' ? '/' : (path ?? defaultCookiePath(context.requestPath)),
      expiresAt,
      secure,
      httpOnly,
      sameSite,
      createdAt: context.now,
    },
  }
}

/**
 * The worker's cookie jar, partitioned by `(deviceId, serviceId)`.
 *
 * **Domain is parsed and then ignored for scoping, deliberately.** The
 * partition key is the device and the service, not a host. Every request the
 * jar answers is a request the worker is making to *one* upstream on behalf of
 * *one* framed service, so a `Domain` attribute could only ever widen a cookie
 * to hosts this jar has no way to address - honouring it would have no
 * observable effect, and not honouring it cannot leak, because the key is not
 * the domain. It is still parsed, because `__Host-` is defined by its absence.
 *
 * **SameSite is parsed and recorded, and has no operative effect.** No
 * cross-site request can arise inside a per-service partition. The
 * `SameSite=None`-requires-`Secure` pairing is therefore *not* enforced: it
 * would protect nothing here, while refusing those cookies would break logins
 * for apps that set them over plain HTTP upstream.
 *
 * **HttpOnly is recorded and is universally true in effect.** The jar is not
 * reachable from the framed realm at all, so every cookie in it is hidden from
 * the app's own JavaScript whether or not the flag was set. That is the cost
 * recorded in section 5.6.2: an app whose *client-side* script reads its own
 * cookie by name will not find it.
 */
export class CookieJar {
  /**
   * @param {object} options
   * @param {CookieStore} options.store Persistence, mirroring `BindingStore`
   * @param {boolean} options.secureOrigin Whether `Secure` may be accepted
   * @param {() => number} [options.now]
   */
  constructor({ store, secureOrigin, now = Date.now }) {
    this.store = store
    this.secureOrigin = secureOrigin
    this.now = now

    /**
     * Partition key -> the cookies in it, as a promise that resolves once.
     *
     * The array is mutated **in place** so that everything already holding it
     * sees a write, and the promise is cached so two concurrent operations on
     * one partition serialise behind the same load instead of racing to
     * overwrite each other with a stale copy.
     *
     * @type {Map<string, Promise<StoredCookie[]>>}
     */
    this.partitions = new Map()

    /**
     * Why the jar refused something, most recent last (section 5.6.2 note 3).
     *
     * Nothing in the platform reports a refused cookie - no exception, no
     * console entry - so a jar that cannot say what it dropped is a jar that
     * believes it succeeded. Both bugs in this area were exactly that.
     *
     * @type {CookieDrop[]}
     */
    this.drops = []

    this.stats = { stored: 0, removed: 0, dropped: 0, expired: 0, headersSent: 0 }
  }

  /**
   * @param {string} key
   * @returns {Promise<StoredCookie[]>}
   */
  partition(key) {
    const cached = this.partitions.get(key)
    if (cached !== undefined) return cached
    const loading = this.store
      .get(key)
      .then((rows) => (Array.isArray(rows) ? rows : []))
      .catch(() => [])
    this.partitions.set(key, loading)
    return loading
  }

  /**
   * @param {string} name
   * @param {string} reason
   * @param {string} raw
   * @returns {CookieDrop}
   */
  recordDrop(name, reason, raw) {
    const drop = { name, reason, raw }
    this.drops.push(drop)
    if (this.drops.length > MAX_COOKIE_DROPS) this.drops.shift()
    this.stats.dropped += 1
    console.warn(`[lem-sw] Refused cookie ${name || '(unnamed)'}: ${reason}`)
    return drop
  }

  /**
   * Read the live cookies of a partition, dropping any that have expired.
   *
   * Expiry is enforced **here**, on read, not only when a cookie is written: a
   * jar that only checks at write time keeps sending a cookie the upstream has
   * already invalidated, for as long as nothing overwrites it.
   *
   * @param {string} deviceId
   * @param {string} serviceId
   * @returns {Promise<StoredCookie[]>}
   */
  async read(deviceId, serviceId) {
    const key = sessionKey(deviceId, serviceId)
    if (key === null) return []
    const cookies = await this.partition(key)
    const now = this.now()
    let expired = 0
    for (let index = cookies.length - 1; index >= 0; index -= 1) {
      const cookie = cookies[index]
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        cookies.splice(index, 1)
        expired += 1
      }
    }
    if (expired > 0) {
      this.stats.expired += expired
      void this.persist(key, cookies)
    }
    return cookies
  }

  /**
   * Build the `Cookie` header for one request, or null when there is nothing.
   *
   * @param {string} deviceId
   * @param {string} serviceId
   * @param {string} upstreamPath Path, possibly with a query string
   * @returns {Promise<string | null>}
   */
  async headerFor(deviceId, serviceId, upstreamPath) {
    const cookies = await this.read(deviceId, serviceId)
    if (cookies.length === 0) return null
    const requestPath = pathWithoutQuery(upstreamPath)
    const matched = cookies.filter((cookie) => cookiePathMatches(requestPath, cookie.path))
    if (matched.length === 0) return null
    // RFC 6265 section 5.4: longer paths first, then oldest first.
    matched.sort((left, right) =>
      right.path.length !== left.path.length
        ? right.path.length - left.path.length
        : left.createdAt - right.createdAt
    )
    this.stats.headersSent += 1
    return matched.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
  }

  /**
   * Take every `Set-Cookie` off one response's header pairs.
   *
   * Each header is its own cookie: they are **not** foldable into one
   * comma-joined value, which is the section 5.6 correction already recorded
   * and the reason the wire carries pairs rather than a map.
   *
   * @param {string} deviceId
   * @param {string} serviceId
   * @param {[string, string][]} pairs Response header pairs from the frame
   * @param {string} upstreamPath Path the request was made to
   * @returns {Promise<CookieReport>}
   */
  async ingest(deviceId, serviceId, pairs, upstreamPath) {
    /** @type {CookieReport} */
    const report = { stored: [], removed: [], dropped: [] }
    const raws = pairs
      .filter(([name]) => name.toLowerCase() === 'set-cookie')
      .map(([, value]) => value)
    if (raws.length === 0) return report

    const key = sessionKey(deviceId, serviceId)
    if (key === null) {
      for (const raw of raws) report.dropped.push(this.recordDrop('', 'no-partition', raw))
      return report
    }

    const cookies = await this.partition(key)
    const requestPath = pathWithoutQuery(upstreamPath)

    for (const raw of raws) {
      const parsed = parseSetCookie(raw, {
        requestPath,
        now: this.now(),
        secureOrigin: this.secureOrigin,
      })
      if ('reason' in parsed) {
        report.dropped.push(this.recordDrop(parsed.name, parsed.reason, raw))
        continue
      }
      const cookie = parsed.cookie
      // Identity is (name, path) inside the partition. Domain is not part of
      // it: see the class note - it has no scoping effect here, so including it
      // could only split one logical cookie into two.
      const existing = cookies.findIndex(
        (candidate) => candidate.name === cookie.name && candidate.path === cookie.path
      )
      if (cookie.expiresAt !== null && cookie.expiresAt <= this.now()) {
        if (existing >= 0) cookies.splice(existing, 1)
        report.removed.push(cookie.name)
        this.stats.removed += 1
        continue
      }
      if (existing >= 0) {
        // RFC 6265 section 5.3 step 11: an overwrite keeps the creation time,
        // so a refreshed session cookie does not jump the `Cookie` ordering.
        cookie.createdAt = cookies[existing].createdAt
        cookies[existing] = cookie
      } else {
        cookies.push(cookie)
      }
      report.stored.push(cookie.name)
      this.stats.stored += 1
    }

    while (cookies.length > MAX_COOKIES_PER_PARTITION) {
      const evicted = cookies.shift()
      if (evicted) report.dropped.push(this.recordDrop(evicted.name, 'partition-full', ''))
    }

    void this.persist(key, cookies)
    return report
  }

  /**
   * @param {string} key
   * @param {StoredCookie[]} cookies
   * @returns {Promise<void>}
   */
  async persist(key, cookies) {
    try {
      await this.store.put(key, [...cookies])
    } catch {
      // A jar that cannot persist still works for the life of this worker.
    }
  }
}

/**
 * Strip the query off a path the jar is asked about.
 *
 * @param {string} upstreamPath
 * @returns {string}
 */
function pathWithoutQuery(upstreamPath) {
  const query = upstreamPath.indexOf('?')
  const path = query < 0 ? upstreamPath : upstreamPath.slice(0, query)
  return path === '' ? '/' : path
}

/**
 * Build the `Headers` for a proxied response.
 *
 * @param {[string, string][]} pairs Upstream header pairs, in order
 * @param {{ deviceId: string, serviceId: string, upstreamPath: string }} context
 * @returns {Headers}
 */
export function buildResponseHeaders(pairs, context) {
  const headers = new Headers()
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase()
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue
    if (lower === 'location') {
      // append, never set: duplicates are why the wire carries pairs at all.
      headers.append(
        name,
        rewriteLocation(value, context.deviceId, context.serviceId, context.upstreamPath)
      )
      continue
    }
    headers.append(name, value)
  }
  headers.set('Content-Security-Policy', SUBSTITUTED_CSP)
  return headers
}

/** The worker's database, and the stores in it. */
const DB_NAME = 'lem-sw'
const BINDING_OBJECT_STORE = 'clientBindings'
const COOKIE_OBJECT_STORE = 'cookies'

/**
 * Version 2 added the cookie jar's store alongside the bindings (section
 * 5.6.2). Both stores are created on demand rather than only at their
 * introducing version, so a browser upgrading from 1 and a browser arriving
 * fresh at 2 end up with the same database.
 */
const DB_VERSION = 2

/**
 * A memoised opener for the worker's database.
 *
 * One per store object, which is fine and deliberate: IndexedDB allows several
 * connections at one version, and the alternative - a module-level singleton -
 * would keep a handle alive across the fake scopes the tests build.
 *
 * @param {IDBFactory} idb
 * @returns {() => Promise<IDBDatabase>}
 */
function createDbOpener(idb) {
  /** @type {Promise<IDBDatabase> | null} */
  let opening = null
  return function open() {
    if (opening !== null) return opening
    opening = new Promise((resolve, reject) => {
      const request = idb.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(BINDING_OBJECT_STORE)) {
          db.createObjectStore(BINDING_OBJECT_STORE, { keyPath: 'clientId' })
        }
        if (!db.objectStoreNames.contains(COOKIE_OBJECT_STORE)) {
          db.createObjectStore(COOKIE_OBJECT_STORE, { keyPath: 'key' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    })
    return opening
  }
}

/**
 * An in-memory cookie store, used when IndexedDB is unavailable.
 *
 * The jar still works for the life of the worker; a restart loses the login.
 *
 * @returns {CookieStore}
 */
export function createMemoryCookieStore() {
  /** @type {Map<string, StoredCookie[]>} */
  const records = new Map()
  return {
    get: (key) => Promise.resolve(records.get(key) ?? null),
    put: (key, cookies) => {
      records.set(key, cookies)
      return Promise.resolve()
    },
  }
}

/**
 * An IndexedDB-backed cookie store.
 *
 * A session cookie has to survive the browser killing an idle worker, or a
 * framed app is logged out every time the user looks away - which is the same
 * failure this feature exists to fix, arriving a minute late.
 *
 * @param {IDBFactory | undefined} factory
 * @returns {CookieStore}
 */
export function createIndexedDbCookieStore(factory) {
  if (!factory) return createMemoryCookieStore()
  const open = createDbOpener(factory)

  return {
    async get(key) {
      const db = await open()
      return await new Promise((resolve) => {
        const request = db
          .transaction(COOKIE_OBJECT_STORE, 'readonly')
          .objectStore(COOKIE_OBJECT_STORE)
          .get(key)
        request.onsuccess = () => {
          const record = /** @type {{ cookies: StoredCookie[] } | undefined} */ (request.result)
          resolve(record?.cookies ?? null)
        }
        request.onerror = () => resolve(null)
      })
    },
    async put(key, cookies) {
      const db = await open()
      await new Promise((resolve) => {
        const request = db
          .transaction(COOKIE_OBJECT_STORE, 'readwrite')
          .objectStore(COOKIE_OBJECT_STORE)
          .put({ key, cookies })
        request.onsuccess = () => resolve(undefined)
        request.onerror = () => resolve(undefined)
      })
    },
  }
}

/**
 * An in-memory binding store, used when IndexedDB is unavailable.
 *
 * Degrades resolution step 4 to a no-op rather than failing the worker: steps
 * 1-3 still resolve every request from a live document.
 *
 * @returns {BindingStore}
 */
export function createMemoryBindingStore() {
  /** @type {Map<string, StoredBinding>} */
  const records = new Map()
  return {
    get: (clientId) => Promise.resolve(records.get(clientId) ?? null),
    put: (clientId, binding) => {
      records.set(clientId, binding)
      return Promise.resolve()
    },
  }
}

/**
 * An IndexedDB-backed binding store.
 *
 * The in-memory map is lost every time the browser kills an idle worker, which
 * it does aggressively. This is what lets a request from a document the worker
 * has forgotten still be attributed - and, just as importantly, still be
 * attributed to the device it was opened for, so a binding written hours ago
 * for another machine is *detectable* rather than invisible.
 *
 * @param {IDBFactory | undefined} factory
 * @returns {BindingStore}
 */
export function createIndexedDbBindingStore(factory) {
  if (!factory) return createMemoryBindingStore()
  const open = createDbOpener(factory)

  return {
    async get(clientId) {
      const db = await open()
      return await new Promise((resolve) => {
        const request = db
          .transaction(BINDING_OBJECT_STORE, 'readonly')
          .objectStore(BINDING_OBJECT_STORE)
          .get(clientId)
        request.onsuccess = () => {
          const record = /** @type {StoredBinding | undefined} */ (request.result)
          resolve(record ?? null)
        }
        request.onerror = () => resolve(null)
      })
    },
    async put(clientId, binding) {
      const db = await open()
      await new Promise((resolve) => {
        const request = db
          .transaction(BINDING_OBJECT_STORE, 'readwrite')
          .objectStore(BINDING_OBJECT_STORE)
          .put({ clientId, ...binding })
        request.onsuccess = () => resolve(undefined)
        request.onerror = () => resolve(undefined)
      })
    },
  }
}

// -- the worker --------------------------------------------------------------

/**
 * The worker's whole decision surface, as a class so tests can drive it without
 * a browser and so a restart is expressible as "construct a new one over the
 * same persistent store".
 */
export class LemAppServiceWorker {
  /**
   * @param {object} options
   * @param {string} options.origin This worker's origin
   * @param {SwClients} options.clients The `clients` API
   * @param {BindingStore} options.bindingStore Persistent client bindings
   * @param {CookieJar} options.cookies The per-service cookie jar (section 5.6.2)
   * @param {() => number} [options.now] Clock, for TTL expiry
   */
  constructor({ origin, clients, bindingStore, cookies, now = Date.now }) {
    this.origin = origin
    this.clients = clients
    this.bindingStore = bindingStore
    this.cookies = cookies
    this.now = now

    /** Bindings for live clients. Lost on every worker restart, by design. */
    this.clientBindings = /** @type {Map<string, Binding>} */ (new Map())

    /** Exactly one active device, ever. Null until the page says otherwise. */
    this.activeDeviceId = /** @type {string | null} */ (null)

    /** Open sessions, keyed `deviceId serviceId`. */
    this.sessions = /** @type {Set<string>} */ (new Set())

    /** The page's end of the bridge. The page pushes it; we never hunt for it. */
    this.bridgePort = /** @type {MessagePort | null} */ (null)

    /**
     * Refused until the page says the tunnel is up. Fail-closed: a request
     * proxied into a dead tunnel becomes a hang, and a hang is the failure mode
     * this design exists to remove.
     */
    this.tunnelUp = false

    /** @type {(() => void)[]} */
    this.bridgeWaiters = []

    this.nextRequestId = 1

    /**
     * Counters the acceptance tests read.
     *
     * `singleSessionFallbacks` is the one that matters: routinely reaching
     * resolution step 5 means steps 1-4 have a bug, and the only way to know is
     * to count it.
     */
    this.stats = {
      resolvedByMemory: 0,
      resolvedByReferrer: 0,
      resolvedByClientUrl: 0,
      resolvedByStore: 0,
      singleSessionFallbacks: 0,
      unresolved: 0,
      deviceMismatches: 0,
      forbidden: 0,
      bridgeTimeouts: 0,
      passedThrough: 0,
    }
  }

  // -- page messages ---------------------------------------------------------

  /**
   * Handle one message from the dashboard page.
   *
   * @param {unknown} data
   * @param {readonly MessagePort[]} ports
   * @returns {void}
   */
  handleMessage(data, ports = []) {
    if (typeof data !== 'object' || data === null) return
    const message = /** @type {Record<string, unknown>} */ (data)

    switch (message.type) {
      case 'LEM_BRIDGE_INIT': {
        const port = ports[0]
        if (!port) return
        this.bridgePort = port
        port.onmessage = (event) => this.handleMessage(event.data)
        port.start?.()
        this.notifyBridgeWaiters()
        return
      }
      case 'LEM_ACTIVE_DEVICE': {
        const deviceId = message.deviceId
        if (typeof deviceId !== 'string') return
        if (deviceId !== this.activeDeviceId) {
          // Sessions belong to the device they were opened on. Keeping them
          // would make the single-session fallback answer for a device that is
          // no longer connected.
          this.sessions.clear()
          this.clientBindings.clear()
        }
        this.activeDeviceId = deviceId
        this.notifyBridgeWaiters()
        return
      }
      case 'LEM_SESSION_OPEN': {
        const key = sessionKey(message.deviceId, message.serviceId)
        if (key !== null) this.sessions.add(key)
        // The page waits for this before it creates the iframe. Without the
        // acknowledgement there is no ordering between "session registered" and
        // "navigation dispatched", and the frame's very first request can be
        // answered 410 by a worker that has not been told about it yet.
        if (typeof message.ackId === 'number') {
          this.bridgePort?.postMessage({ type: 'LEM_SESSION_ACK', ackId: message.ackId })
        }
        return
      }
      case 'LEM_SESSION_CLOSE': {
        const key = sessionKey(message.deviceId, message.serviceId)
        if (key !== null) this.sessions.delete(key)
        return
      }
      case 'LEM_TUNNEL_UP':
        this.tunnelUp = true
        return
      case 'LEM_TUNNEL_DOWN':
        this.tunnelUp = false
        return
      default:
        return
    }
  }

  /** Wake everything waiting on a cold-started bridge. */
  notifyBridgeWaiters() {
    if (!this.bridgeIsReady()) return
    const waiters = this.bridgeWaiters
    this.bridgeWaiters = []
    for (const resolve of waiters) resolve()
  }

  /**
   * The bridge is usable once the page has both handed over a port and told us
   * which device it is connected to. Waiting for the second is what stops a
   * cold-started worker from answering `409` to a perfectly good request
   * merely because it has not been told anything yet.
   *
   * @returns {boolean}
   */
  bridgeIsReady() {
    return this.bridgePort !== null && this.activeDeviceId !== null
  }

  /**
   * Wait up to `BRIDGE_WAIT_MS` for the page to re-initialise the bridge.
   *
   * @returns {Promise<MessagePort | null>}
   */
  async waitForBridge() {
    if (this.bridgeIsReady()) return this.bridgePort
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.bridgeWaiters = this.bridgeWaiters.filter((waiter) => waiter !== onReady)
        resolve(undefined)
      }, BRIDGE_WAIT_MS)
      const onReady = () => {
        clearTimeout(timer)
        resolve(undefined)
      }
      this.bridgeWaiters.push(onReady)
    })
    if (!this.bridgeIsReady()) {
      this.stats.bridgeTimeouts += 1
      return null
    }
    return this.bridgePort
  }

  // -- fetch -----------------------------------------------------------------

  /**
   * Decide, synchronously, whether this request is ours.
   *
   * Returning `null` means "do not call `respondWith`", which leaves the
   * browser to perform the request exactly as it would with no Service Worker
   * installed. That is the only correct answer for a cross-origin URL: a
   * refusal would break apps that legitimately load a public CDN, and proxying
   * it would turn the tunnel into an open proxy onto the user's home network.
   *
   * @param {SwFetchEvent} event
   * @returns {Promise<Response> | null}
   */
  classify(event) {
    let url
    try {
      url = new URL(event.request.url)
    } catch {
      return null
    }

    // A. Not our origin -> not ours.
    if (url.origin !== this.origin) {
      this.stats.passedThrough += 1
      return null
    }

    // The worker's own source is dashboard-owned. A framed app must not be able
    // to read the bridge protocol out of it or trigger a re-registration.
    if (url.pathname === SW_SCRIPT_PATH) {
      this.stats.forbidden += 1
      return Promise.resolve(
        problemResponse('E_SW_FORBIDDEN', 'The service worker source is not readable from an app.')
      )
    }

    // B. An explicit prefix wins, always.
    const parsed = parseAppPath(url.pathname)
    if (parsed !== null) {
      if (event.request.mode === 'navigate' && event.resultingClientId) {
        // resultingClientId, not clientId: at navigation the document being
        // created is the one that will own every subsequent subresource.
        this.bindClient(event.resultingClientId, parsed)
      }
      return this.proxy(parsed.deviceId, parsed.serviceId, parsed.path + url.search, event.request)
    }

    // C. No prefix: the owning client decides.
    return this.resolveAndProxy(event, url)
  }

  /**
   * Resolve a prefix-less same-origin request to a session and proxy it.
   *
   * @param {SwFetchEvent} event
   * @param {URL} url
   * @returns {Promise<Response>}
   */
  async resolveAndProxy(event, url) {
    const binding = await this.resolveBindingForClient(event)
    if (binding === null) {
      this.stats.unresolved += 1
      return problemResponse(
        'E_NO_SESSION',
        `No service session owns ${url.pathname}. Reload the service from the dashboard.`
      )
    }
    return await this.proxy(
      binding.deviceId,
      binding.serviceId,
      url.pathname + url.search,
      event.request
    )
  }

  /**
   * Resolution steps 1-6 of the spec, in order, stopping at the first hit.
   *
   * Every step yields a `{deviceId, serviceId}` pair rather than a bare service
   * id. That is the whole reason a stale binding is detectable: the device
   * travels with the binding, so the caller can reject it instead of quietly
   * forwarding to whichever machine happens to be connected now.
   *
   * @param {SwFetchEvent} event
   * @returns {Promise<Binding | null>}
   */
  async resolveBindingForClient(event) {
    const clientId = event.clientId ?? ''

    // 1. In-memory map.
    if (clientId) {
      const cached = this.clientBindings.get(clientId)
      if (cached) {
        this.stats.resolvedByMemory += 1
        return cached
      }
    }

    // 2. Referrer. The cheapest signal, and the one an app can switch off.
    const fromReferrer = bindingFromUrl(event.request.referrer, this.origin)
    if (fromReferrer !== null) {
      this.stats.resolvedByReferrer += 1
      if (clientId) this.bindClient(clientId, fromReferrer)
      return fromReferrer
    }

    // 3. The client's own URL. Survives `Referrer-Policy: no-referrer`, and
    //    works for window, worker and sharedworker clients alike - a worker the
    //    app spawned was itself loaded from inside the prefix.
    if (clientId) {
      const client = await this.clients.get(clientId)
      const fromClient = client ? bindingFromUrl(client.url, this.origin) : null
      if (fromClient !== null) {
        this.stats.resolvedByClientUrl += 1
        this.bindClient(clientId, fromClient)
        return fromClient
      }
    }

    // 4. Persisted bindings: the map above is gone after every worker restart.
    if (clientId) {
      const stored = await this.bindingStore.get(clientId)
      if (stored !== null && stored.expiresAt > this.now()) {
        const binding = { deviceId: stored.deviceId, serviceId: stored.serviceId }
        this.stats.resolvedByStore += 1
        this.clientBindings.set(clientId, binding)
        return binding
      }
    }

    // 5. Single open session on the active device. Sessions for any other
    //    device are not candidates - guessing across machines is the failure
    //    this design is built to prevent.
    const candidates = [...this.sessions]
      .map(parseSessionKey)
      .filter((session) => session.deviceId === this.activeDeviceId)
    if (candidates.length === 1) {
      this.stats.singleSessionFallbacks += 1
      console.warn(
        `[lem-sw] Fell back to the single open session for ${event.request.url}; ` +
          'steps 1-4 should have resolved this.'
      )
      return candidates[0]
    }

    // 6. Fail closed. Never guess between two sessions.
    return null
  }

  /**
   * Record a binding, in memory now and in storage shortly.
   *
   * The in-memory write is synchronous on purpose: a navigation's subresources
   * can arrive in the same task, long before an IndexedDB transaction settles.
   *
   * @param {string} clientId
   * @param {Binding} binding
   * @returns {void}
   */
  bindClient(clientId, binding) {
    this.clientBindings.set(clientId, binding)
    void this.bindingStore
      .put(clientId, { ...binding, expiresAt: this.now() + BINDING_TTL_MS })
      .catch(() => {
        // A worker that cannot persist bindings still resolves every request
        // from a live document via steps 1-3.
      })
  }

  /**
   * Is a session open for this exact (device, service) pair?
   *
   * @param {string} deviceId
   * @param {string} serviceId
   * @returns {boolean}
   */
  hasSession(deviceId, serviceId) {
    const key = sessionKey(deviceId, serviceId)
    return key !== null && this.sessions.has(key)
  }

  /**
   * Perform one request over the page's tunnel.
   *
   * @param {string} deviceId Device the request named
   * @param {string} serviceId Service the request named
   * @param {string} upstreamPath Path to ask the upstream for, including query
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async proxy(deviceId, serviceId, upstreamPath, request) {
    const bridge = await this.waitForBridge()
    if (bridge === null) {
      return problemResponse(
        'E_BRIDGE_UNAVAILABLE',
        'The Lem dashboard is not reachable from this frame. Reload the dashboard tab.'
      )
    }

    // The device check. After the bridge, so a cold-started worker is not
    // answering out of ignorance; before anything is handed to the page, so a
    // mismatch puts no frame on the wire. Never re-routed to the active device.
    if (deviceId !== this.activeDeviceId) {
      this.stats.deviceMismatches += 1
      return problemResponse(
        'E_DEVICE_MISMATCH',
        `This view belongs to device ${deviceId}, but the dashboard is connected to ` +
          `${String(this.activeDeviceId)}. Reload the dashboard and open the service again.`
      )
    }

    if (!this.hasSession(deviceId, serviceId)) {
      return problemResponse(
        'E_SESSION_CLOSED',
        `The session for ${serviceId} is closed. Open the service again from the dashboard.`
      )
    }

    if (!this.tunnelUp) {
      return problemResponse('E_TUNNEL_DOWN', 'The tunnel to your device is down.')
    }

    /** @type {ArrayBuffer | null} */
    let body = null
    if (request.body !== null && request.method !== 'GET' && request.method !== 'HEAD') {
      body = await request.arrayBuffer()
    }

    // There is no `Cookie` header in `request.headers` to forward: the browser
    // appends it *after* this worker has run, so the jar supplies it here. Any
    // `cookie` that somehow is in there is dropped rather than added to, so a
    // request can never carry two of them.
    //
    // This is a plain array, never a `Headers`. A `Headers` with the "request"
    // guard drops `Cookie` silently - the mirror of the rule that makes the jar
    // necessary in the first place - and undici would not have told us.
    const headers = /** @type {[string, string][]} */ (
      [...request.headers.entries()].filter(([name]) => name.toLowerCase() !== 'cookie')
    )
    const cookieHeader = await this.cookies.headerFor(deviceId, serviceId, upstreamPath)
    if (cookieHeader !== null) headers.push(['Cookie', cookieHeader])
    const reqId = this.nextRequestId
    this.nextRequestId = this.nextRequestId >= 0xffffffff ? 1 : this.nextRequestId + 1

    return await this.exchange(bridge, {
      reqId,
      deviceId,
      serviceId,
      upstreamPath,
      method: request.method,
      headers,
      body,
      signal: request.signal,
      // Navigations only: this is the document the app boots from, and the shim
      // has to run before the app's own first script.
      isNavigation: request.mode === 'navigate',
    })
  }

  /**
   * Run one request/response exchange over a fresh `MessageChannel`.
   *
   * The `Response` resolves as soon as the head arrives, wrapping a
   * `ReadableStream` that later chunks feed. That is what makes a `<script>`
   * start executing and model tokens paint as they arrive, instead of the whole
   * body being buffered before the frame sees any of it.
   *
   * @param {MessagePort} bridge
   * @param {object} exchange
   * @param {number} exchange.reqId
   * @param {string} exchange.deviceId
   * @param {string} exchange.serviceId
   * @param {string} exchange.upstreamPath
   * @param {string} exchange.method
   * @param {[string, string][]} exchange.headers
   * @param {ArrayBuffer | null} exchange.body
   * @param {AbortSignal} [exchange.signal]
   * @param {boolean} [exchange.isNavigation]
   * @returns {Promise<Response>}
   */
  exchange(bridge, exchange) {
    const channel = new MessageChannel()
    const port = channel.port1

    return new Promise((resolve) => {
      /** @type {ReadableStreamDefaultController<Uint8Array> | null} */
      let controller = null
      let headSettled = false

      const finish = () => {
        port.onmessage = null
        port.close?.()
      }

      /** @param {string} code */
      const fail = (code) => {
        const known = code in ERROR_STATUS ? /** @type {keyof typeof ERROR_STATUS} */ (code) : null
        if (controller !== null) {
          // error(), never close(): a closed stream hands the app a truncated
          // body it believes is whole, which is silent corruption. An errored
          // one rejects the frame's fetch exactly as an interrupted download
          // does.
          controller.error(new Error(known ?? 'E_INTERNAL'))
          controller = null
          finish()
          return
        }
        if (!headSettled) {
          headSettled = true
          resolve(
            problemResponse(
              known ?? 'E_INTERNAL',
              `The tunnel could not complete this request (${code}).`
            )
          )
        }
        finish()
      }

      port.onmessage = (event) => {
        const message = /** @type {Record<string, unknown>} */ (event.data)
        switch (message?.type) {
          case 'LEM_RESPONSE_HEAD': {
            if (headSettled) return
            headSettled = true
            const status = typeof message.status === 'number' ? message.status : 502
            const pairs = /** @type {[string, string][]} */ (message.headers ?? [])
            // `pairs` carries every upstream `Set-Cookie`, because the server
            // relays them (#72) and the page reads them off the frame rather
            // than off a guarded `Response`. The jar takes them here;
            // `buildResponseHeaders` then drops them, because a browser would
            // not deliver them to the frame regardless.
            //
            // Fire-and-forget: the head must resolve now, and the jar's write
            // lands in an earlier microtask than any request the frame makes in
            // reaction to this response.
            void this.cookies.ingest(
              exchange.deviceId,
              exchange.serviceId,
              pairs,
              exchange.upstreamPath
            )
            const responseHeaders = buildResponseHeaders(pairs, {
              deviceId: exchange.deviceId,
              serviceId: exchange.serviceId,
              upstreamPath: exchange.upstreamPath,
            })
            if (BODYLESS_STATUSES.has(status)) {
              resolve(new Response(null, { status, headers: responseHeaders }))
              finish()
              return
            }
            const stream = new ReadableStream({
              start: (streamController) => {
                controller = streamController
              },
              cancel: () => {
                controller = null
                bridge.postMessage({ type: 'LEM_CANCEL', reqId: exchange.reqId })
                finish()
              },
            })
            const body = shouldInjectShim(exchange.isNavigation === true, responseHeaders)
              ? stream.pipeThrough(
                  createShimInjector(() => {
                    // HTTP still works in this document; WebSockets in it do
                    // not. Saying so beats a frame that half-works in silence.
                    bridge.postMessage({
                      type: 'LEM_SHIM_SKIPPED',
                      reqId: exchange.reqId,
                      path: exchange.upstreamPath,
                    })
                  })
                )
              : stream
            resolve(new Response(body, { status, headers: responseHeaders }))
            return
          }
          case 'LEM_RESPONSE_CHUNK': {
            const buffer = message.buf
            if (controller !== null && isArrayBuffer(buffer)) {
              controller.enqueue(new Uint8Array(buffer))
            }
            return
          }
          case 'LEM_RESPONSE_END': {
            controller?.close()
            controller = null
            finish()
            return
          }
          case 'LEM_RESPONSE_ERROR': {
            fail(typeof message.code === 'string' ? message.code : 'E_INTERNAL')
            return
          }
          default:
            return
        }
      }
      port.start?.()

      exchange.signal?.addEventListener(
        'abort',
        () => {
          bridge.postMessage({ type: 'LEM_CANCEL', reqId: exchange.reqId })
        },
        { once: true }
      )

      /** @type {Transferable[]} */
      const transfer = [channel.port2]
      if (exchange.body !== null) transfer.push(exchange.body)

      // The reply port travels in the transfer list only, never in the message
      // body: the page reads it from `event.ports[0]`.
      bridge.postMessage(
        {
          type: 'LEM_FETCH',
          reqId: exchange.reqId,
          deviceId: exchange.deviceId,
          serviceId: exchange.serviceId,
          method: exchange.method,
          path: exchange.upstreamPath,
          headers: exchange.headers,
          body: exchange.body,
        },
        transfer
      )
    })
  }
}

/**
 * Build a session key, rejecting anything that is not a pair of strings.
 *
 * @param {unknown} deviceId
 * @param {unknown} serviceId
 * @returns {string | null}
 */
function sessionKey(deviceId, serviceId) {
  if (typeof deviceId !== 'string' || typeof serviceId !== 'string') return null
  if (deviceId === '' || serviceId === '') return null
  return `${deviceId} ${serviceId}`
}

/**
 * @param {string} key
 * @returns {Binding}
 */
function parseSessionKey(key) {
  const [deviceId, serviceId] = key.split(' ')
  return { deviceId, serviceId }
}

// -- worker wiring -----------------------------------------------------------

/**
 * @typedef {object} LemSwScope
 * @property {{ origin: string }} location
 * @property {SwClients} clients
 * @property {(type: string, listener: (event: never) => void) => void} addEventListener
 * @property {IDBFactory} [indexedDB]
 */

/**
 * Attach the worker to a real `ServiceWorkerGlobalScope`.
 *
 * Exported so a test can drive the wiring with a fake scope; called below for
 * the real one. The `bindingStore` override exists for the same reason: a test
 * has to be able to survive a worker restart over one store, and `indexedDB`
 * is not something a fake scope can supply.
 *
 * @param {LemSwScope} scope
 * @param {{ bindingStore?: BindingStore, cookieStore?: CookieStore }} [overrides]
 * @returns {LemAppServiceWorker}
 */
export function installServiceWorker(scope, overrides = {}) {
  const origin = scope.location.origin
  const worker = new LemAppServiceWorker({
    origin,
    clients: scope.clients,
    bindingStore: overrides.bindingStore ?? createIndexedDbBindingStore(scope.indexedDB),
    cookies: new CookieJar({
      store: overrides.cookieStore ?? createIndexedDbCookieStore(scope.indexedDB),
      // The dashboard's origin decides whether `Secure` is acceptable, because
      // that is the origin this jar belongs to.
      secureOrigin: isTrustworthyOrigin(origin),
    }),
  })

  // No skipWaiting()/clients.claim(): a newly deployed worker takes over on the
  // next navigation. Claiming mid-session would leave an iframe controlled by a
  // worker that never received LEM_SESSION_OPEN.
  scope.addEventListener(
    'activate',
    /** @param {{ waitUntil: (p: Promise<unknown>) => void }} event */
    (event) => {
      event.waitUntil(
        scope.clients
          .matchAll({ includeUncontrolled: true, type: 'window' })
          .then((windows) => {
            for (const client of windows) client.postMessage({ type: 'LEM_BRIDGE_HELLO' })
          })
          .catch(() => undefined)
      )
    }
  )

  scope.addEventListener(
    'message',
    /** @param {{ data: unknown, ports: readonly MessagePort[] }} event */
    (event) => {
      worker.handleMessage(event.data, event.ports)
    }
  )

  scope.addEventListener(
    'fetch',
    /** @param {SwFetchEvent} event */
    (event) => {
      const response = worker.classify(event)
      if (response === null) return
      event.respondWith(response)
    }
  )

  return worker
}

/* c8 ignore start -- only reachable inside a real ServiceWorkerGlobalScope */
const globalScope = /** @type {LemSwScope | null} */ (
  'ServiceWorkerGlobalScope' in globalThis && 'clients' in globalThis
    ? /** @type {unknown} */ (globalThis)
    : null
)
if (globalScope !== null) {
  installServiceWorker(globalScope)
}
/* c8 ignore stop */
