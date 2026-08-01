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
 * Allowlist for URLs the dashboard is willing to put in an `<iframe src>`.
 */

/**
 * Hostnames a framed app may live on.
 *
 * A service's `endpoint` comes from the far-side server, so it is untrusted
 * input handed straight to an iframe. Restricting it to loopback does two
 * things: it rejects `javascript:`/`data:` and arbitrary remote origins, and it
 * guarantees the frame can never be same-origin with this dashboard - which is
 * what makes retaining `allow-same-origin` in the sandbox safe. (That flag
 * combined with `allow-scripts` on *same-origin* content lets the framed
 * document remove its own sandbox.)
 */
const ALLOWED_APP_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const ALLOWED_APP_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Validate a server-supplied app URL.
 *
 * @returns the normalised URL, or `null` when it must not be framed.
 */
export function toFramableUrl(raw: string | null | undefined): string | null {
  if (!raw) return null

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }

  if (!ALLOWED_APP_PROTOCOLS.has(parsed.protocol)) return null
  if (!ALLOWED_APP_HOSTNAMES.has(parsed.hostname)) return null
  if (typeof window !== 'undefined' && parsed.origin === window.location.origin) return null

  return parsed.toString()
}
