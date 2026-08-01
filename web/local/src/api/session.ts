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

// Runtime credential delivery for the local dashboard (issue #48).
//
// The dashboard needs a bearer token whenever the API is not on a verified
// loopback bind. It cannot read ~/.lem/api_token, and it must not be built with
// one: Vite inlines `import.meta.env.VITE_*` as plaintext string literals, so a
// build-time token lands verbatim in dist/assets/*.js and is readable by anyone
// who loads the page.
//
// So the operator pastes the root token once, at runtime. It is traded
// immediately for a short-lived session token (POST /v1/auth/session) and then
// dropped; only the session token is ever stored.

import { API_BASE_URL, ApiError, CLIENT_HEADER, CLIENT_NAME, toApiError } from './http'

/** Key under which the session token is stored, in whichever Storage. */
export const SESSION_STORAGE_KEY = 'lem.session_token'

/** Response body of POST /v1/auth/session. */
export interface SessionCredential {
  token: string
  expires_at: string
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
//
// sessionStorage is the default, deliberately. It is scoped to the tab and dies
// with it, so a shared or borrowed machine does not keep a working credential
// for Docker sitting in a profile that survives reboots - and the token is
// cheap to re-enter, since the operator has the file open anyway.
//
// localStorage is the opt-in ("remember on this device"), unchecked by default.
// It survives tab close and restart, which is the point and also the cost: any
// XSS on this origin can read it later, not just while the tab is open. The
// 12-hour server-side TTL bounds that either way.

function storageFor(remember: boolean): Storage | null {
  // Storage access throws in some privacy modes rather than returning null.
  try {
    return remember ? window.localStorage : window.sessionStorage
  } catch {
    return null
  }
}

// Anything that wants to know whether a credential is currently held - today
// only the sign-out control, which must not offer to sign out of nothing.
type SessionListener = (token: string | null) => void
const sessionListeners = new Set<SessionListener>()

function notifySessionChanged(): void {
  const token = readSessionToken()
  for (const listener of sessionListeners) {
    listener(token)
  }
}

/**
 * Watch for the stored session token appearing or disappearing.
 *
 * @param listener - Called with the new value on every change
 * @returns Unsubscribe function
 */
export function subscribeToSessionToken(listener: SessionListener): () => void {
  sessionListeners.add(listener)
  return () => {
    sessionListeners.delete(listener)
  }
}

/**
 * Read the stored session token.
 *
 * @returns The session token, preferring the tab-scoped copy, or null
 */
export function readSessionToken(): string | null {
  return (
    storageFor(false)?.getItem(SESSION_STORAGE_KEY) ??
    storageFor(true)?.getItem(SESSION_STORAGE_KEY) ??
    null
  )
}

/** Remove the token from both storages without announcing the change. */
function removeStoredToken(): void {
  storageFor(false)?.removeItem(SESSION_STORAGE_KEY)
  storageFor(true)?.removeItem(SESSION_STORAGE_KEY)
}

/**
 * Persist a session token.
 *
 * @param token - Session token returned by the exchange
 * @param remember - True to keep it in localStorage instead of sessionStorage
 */
export function storeSessionToken(token: string, remember: boolean): void {
  // Clear both first so toggling "remember" cannot leave a stale copy behind in
  // the other Storage, where readSessionToken would eventually find it again.
  removeStoredToken()
  storageFor(remember)?.setItem(SESSION_STORAGE_KEY, token)
  notifySessionChanged()
}

/**
 * Forget the stored session token, wherever it lives.
 *
 * Both storages are cleared unconditionally, not just the one the current
 * "remember" choice points at: someone who ticked the box and later did not
 * would otherwise leave a working credential behind in localStorage.
 */
export function clearSessionToken(): void {
  removeStoredToken()
  notifySessionChanged()
}

/**
 * Forget the stored token only if it is still the one given.
 *
 * The dashboard fires several requests at once, so two of them can both fail
 * with 401 on the same dead token. Without this check the second one would wipe
 * the *replacement* the first one just obtained.
 *
 * @param token - The token the caller used and saw rejected
 */
export function clearSessionTokenIfCurrent(token: string): void {
  if (readSessionToken() === token) {
    clearSessionToken()
  }
}

// ---------------------------------------------------------------------------
// Exchange
// ---------------------------------------------------------------------------

/**
 * Trade the root API token for a session token and store the result.
 *
 * The root token is a parameter and nothing else: it is never written to
 * storage, never kept in component state, and is unreachable once this call
 * settles.
 *
 * @param rootToken - Contents of ~/.lem/api_token
 * @param remember - True to keep the session token across tab closes
 * @returns The minted session token
 * @throws ApiError if the server refuses the root token or is unreachable
 */
export async function exchangeRootToken(rootToken: string, remember: boolean): Promise<string> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}/v1/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [CLIENT_HEADER]: CLIENT_NAME,
        Authorization: `Bearer ${rootToken}`,
      },
    })
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : 'Unknown error', 0)
  }

  if (!response.ok) {
    throw await toApiError(response)
  }

  const credential = (await response.json()) as SessionCredential
  storeSessionToken(credential.token, remember)
  return credential.token
}

/**
 * Revoke the stored session server-side and forget it locally.
 *
 * This is the off switch for "remember on this device". Without it that opt-in
 * is one-way: tick the box on a borrowed machine and the credential sits in
 * localStorage with no in-product way to get it out again.
 *
 * The local copy is dropped FIRST and unconditionally. The revoke call is
 * best-effort and its failure is deliberately not surfaced - a sign-out that
 * leaves the credential in the browser because the server had already
 * restarted, or the network was down, is the worst possible outcome.
 */
export async function endSession(): Promise<void> {
  const token = readSessionToken()
  clearSessionToken()
  if (token === null) {
    return
  }
  try {
    await fetch(`${API_BASE_URL}/v1/auth/session`, {
      method: 'DELETE',
      headers: {
        [CLIENT_HEADER]: CLIENT_NAME,
        Authorization: `Bearer ${token}`,
      },
    })
  } catch {
    // Already gone locally; nothing useful to do.
  }
}

// ---------------------------------------------------------------------------
// Prompt coordination
// ---------------------------------------------------------------------------
//
// The dashboard issues several requests at once (services, jobs, tunnel
// status). On a fresh load against a token-requiring server they all 401 within
// a few milliseconds of each other. Every one of them must end up retried, but
// the operator must be asked exactly once - so the requests queue behind a
// single prompt and a single exchange.

type CredentialResolver = (token: string | null) => void

let waiting: CredentialResolver[] = []
let promptIsOpen = false
let openPrompt: (() => void) | null = null

/**
 * Register the UI that renders the credential prompt.
 *
 * @param open - Called when a request needs a credential
 * @returns Unsubscribe function
 */
export function subscribeToCredentialPrompt(open: () => void): () => void {
  openPrompt = open
  return () => {
    if (openPrompt === open) {
      openPrompt = null
    }
  }
}

/**
 * Ask the operator for a credential, coalescing concurrent callers.
 *
 * @param staleToken - The token the caller used and saw rejected, or null if it
 *   had none. If storage already holds a *different* token, another in-flight
 *   request has re-authenticated in the meantime and that one is returned
 *   without prompting again.
 * @returns The session token to retry with, or null if the operator declined
 */
export function requestCredential(staleToken: string | null): Promise<string | null> {
  const current = readSessionToken()
  if (current !== null && current !== staleToken) {
    return Promise.resolve(current)
  }

  // No prompt is mounted (tests, or a request fired before the app renders).
  // Resolving null lets the 401 surface instead of hanging the caller forever.
  if (openPrompt === null) {
    return Promise.resolve(null)
  }

  return new Promise<string | null>((resolve) => {
    waiting.push(resolve)
    if (!promptIsOpen) {
      promptIsOpen = true
      openPrompt?.()
    }
  })
}

/**
 * Settle every request waiting on the prompt.
 *
 * @param token - The new session token, or null if the operator cancelled
 */
export function resolveCredentialRequest(token: string | null): void {
  promptIsOpen = false
  const resolvers = waiting
  waiting = []
  for (const resolve of resolvers) {
    resolve(token)
  }
}

/** Drop all prompt state. Test-only; nothing in the app needs to reset this. */
export function resetCredentialState(): void {
  waiting = []
  promptIsOpen = false
  openPrompt = null
}
