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
 * Runtime configuration, validated at startup.
 *
 * Every endpoint used to fall back to a `localhost` literal spread across
 * `App.tsx`, `api/auth.ts` and `Login.tsx`. Those defaults are baked into the
 * production bundle by Vite, so a deployment that forgets `VITE_SIGNAL_URL`
 * ships a dashboard that silently tries to reach the *visitor's* machine - and
 * on an HTTPS host the browser blocks `ws://` as mixed content with nothing in
 * the UI to explain it.
 *
 * So: localhost defaults are dev-only, anything missing or mixed-content is a
 * hard, visible configuration error rather than a mystery.
 */

/** Endpoints the app needs. */
export interface AppConfig {
  /** Signaling server WebSocket URL, e.g. `wss://signal.lem.gg/signal`. */
  signalUrl: string
  /** Signaling server HTTP base URL, e.g. `https://signal.lem.gg`. */
  apiBaseUrl: string
  /** Relay server WebSocket base URL, e.g. `wss://relay.lem.gg`. */
  relayUrl: string
  /** ICE servers, opt-in via `VITE_ICE_SERVERS` (comma-separated URLs). */
  iceServers: RTCIceServer[]
}

const WS_PROTOCOLS = ['ws:', 'wss:']
const HTTP_PROTOCOLS = ['http:', 'https:']
const INSECURE_PROTOCOLS = ['ws:', 'http:']

function pageIsSecure(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'https:'
}

function secureEquivalent(protocol: string): string {
  return protocol === 'ws:' ? 'wss:' : 'https:'
}

function resolveUrl(
  name: string,
  configured: string | undefined,
  devFallback: string,
  allowedProtocols: readonly string[]
): string {
  const value = configured?.trim()

  if (!value) {
    if (import.meta.env.PROD) {
      throw new Error(
        `${name} is not set. Production builds must configure it explicitly ` +
          `(see web/remote/.env.production.example); the ${devFallback} development ` +
          `default would point users at their own machine.`
      )
    }
    return devFallback
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} is not a valid absolute URL: ${value}`)
  }

  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new Error(
      `${name} must use one of ${allowedProtocols.join(', ')} but is ${parsed.protocol} (${value})`
    )
  }

  if (pageIsSecure() && INSECURE_PROTOCOLS.includes(parsed.protocol)) {
    throw new Error(
      `${name} is ${value}, but this dashboard is served over HTTPS. The browser ` +
        `blocks ${parsed.protocol} as mixed content. Use ` +
        `${secureEquivalent(parsed.protocol)}//${parsed.host}${parsed.pathname} instead.`
    )
  }

  return value
}

/**
 * Parse `VITE_ICE_SERVERS`: a comma-separated list of STUN/TURN URLs.
 *
 * Empty by default on purpose - see `DEFAULT_ICE_SERVERS` in `lib/webrtc.ts`.
 */
function resolveIceServers(configured: string | undefined): RTCIceServer[] {
  const urls = (configured ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  if (urls.length === 0) return []

  for (const url of urls) {
    if (!/^(stun|stuns|turn|turns):/.test(url)) {
      throw new Error(
        `VITE_ICE_SERVERS entry "${url}" must start with stun:, stuns:, turn: or turns:`
      )
    }
  }

  return [{ urls }]
}

function buildConfig(): AppConfig {
  const env = import.meta.env

  return {
    signalUrl: resolveUrl(
      'VITE_SIGNAL_URL',
      env.VITE_SIGNAL_URL,
      'ws://localhost:8000/signal',
      WS_PROTOCOLS
    ),
    apiBaseUrl: resolveUrl(
      'VITE_API_BASE_URL',
      env.VITE_API_BASE_URL,
      'http://localhost:8000',
      HTTP_PROTOCOLS
    ),
    relayUrl: resolveUrl('VITE_RELAY_URL', env.VITE_RELAY_URL, 'ws://localhost:8001', WS_PROTOCOLS),
    iceServers: resolveIceServers(env.VITE_ICE_SERVERS),
  }
}

let resolvedConfig: AppConfig | null = null
let resolvedError: string | null = null

try {
  resolvedConfig = buildConfig()
} catch (error) {
  resolvedError = error instanceof Error ? error.message : String(error)
  console.error('[Config] Invalid configuration:', resolvedError)
}

/**
 * The validated configuration, or `null` when validation failed.
 * Check {@link configError} first.
 */
export const config: AppConfig | null = resolvedConfig

/** Human-readable configuration error, or `null` when everything validated. */
export const configError: string | null = resolvedError

/**
 * The local Lem server, as addressed *from the machine at the far end of the
 * tunnel*. `localhost` is correct here: the request is resolved by the local
 * server, not by this browser.
 */
export const LOCAL_API_BASE_URL: string =
  import.meta.env.VITE_LOCAL_API_URL?.trim() ?? 'http://localhost:5142'

/** Build a URL for the tunneled local Lem API. */
export function localApiUrl(path: string): string {
  return `${LOCAL_API_BASE_URL}${path}`
}
