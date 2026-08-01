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
 * Tunnel protocol v3 error taxonomy.
 *
 * One numeric space serves both the `HTTP_CANCEL.reason_code` field on the wire
 * and the error codes surfaced to a caller. Codes are allocated as
 * `1000 + ordinal` so they fit the uint16 `reason_code` field.
 *
 * The same table exists in `server/app/tunnel/errors.py`, and both are pinned to
 * `protocol/tunnel-v3.json` by tests in both languages. That fixture is the
 * single source of truth: FrameType drifted between the Python and TypeScript
 * codecs once already (v1 to v2), and a table nobody cross-checks is how it
 * happened.
 */

export const TunnelErrorCode = {
  E_NO_SESSION: 1000,
  E_DEVICE_MISMATCH: 1001,
  E_SW_FORBIDDEN: 1002,
  E_BRIDGE_UNAVAILABLE: 1003,
  E_TUNNEL_DOWN: 1004,
  E_SESSION_CLOSED: 1005,
  E_TIMEOUT_HEAD: 1006,
  E_TIMEOUT_STREAM: 1007,
  E_TOO_LARGE: 1008,
  E_PROTO_VERSION: 1009,
  E_PROTO_V2_FRAME: 1010,
  E_PROTO_MALFORMED: 1011,
  E_UPSTREAM: 1012,
  E_UNKNOWN_SERVICE: 1013,
  E_INTERNAL: 1014,
} as const

export type TunnelErrorName = keyof typeof TunnelErrorCode
export type TunnelErrorCodeValue = (typeof TunnelErrorCode)[TunnelErrorName]

/** HTTP status each code renders as when it has to become a response. */
export const HTTP_STATUS_FOR_ERROR: Record<TunnelErrorName, number> = {
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
} as const

const NAME_BY_CODE = new Map<number, TunnelErrorName>(
  (Object.entries(TunnelErrorCode) as [TunnelErrorName, number][]).map(([name, code]) => [
    code,
    name,
  ])
)

/**
 * Resolve a wire `reason_code` to its name.
 *
 * Unknown codes are not guessed at: a peer sending one is either newer or
 * broken, and both cases want to be visible.
 */
export function errorNameForCode(code: number): TunnelErrorName | null {
  return NAME_BY_CODE.get(code) ?? null
}

/**
 * A tunnel exchange failed with a code from the taxonomy.
 *
 * Carries the code so callers can branch on it; `message` is for humans and
 * logs, never for control flow.
 */
export class LemProxyError extends Error {
  readonly code: TunnelErrorName
  readonly reasonCode: TunnelErrorCodeValue

  constructor(code: TunnelErrorName, message?: string) {
    super(message ?? code)
    this.name = 'LemProxyError'
    this.code = code
    this.reasonCode = TunnelErrorCode[code]
  }

  /** HTTP status this failure renders as. */
  get httpStatus(): number {
    return HTTP_STATUS_FOR_ERROR[this.code]
  }
}
