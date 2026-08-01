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
 * Runtime credential delivery, end to end (issue #48).
 *
 * These drive the real client, the real session store and the real dialog with
 * only `fetch` mocked, because the bugs worth catching here live in the seams:
 * one prompt for N concurrent 401s, the original request actually being
 * retried, and a dead session being cleared rather than re-sent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CredentialPrompt } from './CredentialPrompt'
import { SessionStatus } from './SessionStatus'
import { getServices } from '../api/client'
import { ApiError } from '../api/http'
import { SESSION_STORAGE_KEY, resetCredentialState } from '../api/session'
import type { Service } from '../api/types'

const ROOT_TOKEN = 'root-token-from-the-lem-home-file'
const SESSION_TOKEN = 'minted-session-token'
const SERVICES: Service[] = [
  {
    id: 'ollama',
    name: 'Ollama',
    category: 'backend',
    description: 'Local LLM runtime',
    status: 'running',
    host_port: null,
    endpoint: null,
    tags: [],
    depends_on: [],
    has_api: true,
    has_ui: false,
  },
]

interface RecordedCall {
  url: string
  method: string
  authorization: string | null
}

let calls: RecordedCall[] = []

/**
 * Build a minimal Response-shaped object.
 *
 * Cast rather than constructed: the production code touches only these four
 * members, and a real Response would drag undici's behaviour into a jsdom test
 * for no benefit.
 *
 * @param status - HTTP status
 * @param body - JSON body
 * @returns Something the client will treat as a Response
 */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

const UNAUTHORIZED = {
  type: 'https://lem.gg/errors/unauthorized',
  title: 'Unauthorized',
  status: 401,
  detail: 'A valid API token is required. See ~/.lem/api_token.',
}

/**
 * Install a fetch stub that behaves like the local API's auth rules.
 *
 * @param options - `acceptRoot` is the token POST /v1/auth/session will accept
 */
function installFetch(options: { acceptRoot?: string } = {}): void {
  const acceptRoot = options.acceptRoot ?? ROOT_TOKEN

  // `input` is typed as string rather than RequestInfo: every call site in the
  // client passes a URL string, and widening it here would only invite
  // stringifying a Request object that never arrives.
  const stub = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const authorization = headers.Authorization ?? null
    calls.push({ url, method, authorization })

    if (url.endsWith('/v1/auth/session') && method === 'POST') {
      return Promise.resolve(
        authorization === `Bearer ${acceptRoot}`
          ? jsonResponse(201, { token: SESSION_TOKEN, expires_at: '2026-08-02T00:00:00+00:00' })
          : jsonResponse(401, UNAUTHORIZED)
      )
    }

    if (url.endsWith('/v1/auth/session') && method === 'DELETE') {
      // The real endpoint answers 204 whether or not the token was known.
      return Promise.resolve(jsonResponse(204, null))
    }

    // Every other /v1/* path needs a live session token.
    return Promise.resolve(
      authorization === `Bearer ${SESSION_TOKEN}`
        ? jsonResponse(200, SERVICES)
        : jsonResponse(401, UNAUTHORIZED)
    )
  })

  vi.stubGlobal('fetch', stub)
}

/**
 * Every value held in a Storage, whatever the key.
 *
 * @param storage - localStorage or sessionStorage
 * @returns The stored values
 */
function storedValues(storage: Storage): string[] {
  const values: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key !== null) {
      values.push(storage.getItem(key) ?? '')
    }
  }
  return values
}

function sessionExchanges(): RecordedCall[] {
  return calls.filter((call) => call.url.endsWith('/v1/auth/session') && call.method === 'POST')
}

/** userEvent with the pointer-events check off - Radix sets body { pointer-events: none }. */
function user(): ReturnType<typeof userEvent.setup> {
  return userEvent.setup({ pointerEventsCheck: 0 })
}

async function submitToken(token: string, remember = false): Promise<void> {
  const actor = user()
  await actor.type(await screen.findByLabelText('API token'), token)
  if (remember) {
    await actor.click(screen.getByRole('checkbox', { name: /remember on this device/i }))
  }
  await actor.click(screen.getByRole('button', { name: 'Connect' }))
}

describe('CredentialPrompt', () => {
  beforeEach(() => {
    calls = []
    resetCredentialState()
    window.sessionStorage.clear()
    window.localStorage.clear()
    installFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('prompts on 401, exchanges the token, and retries the original request', async () => {
    render(<CredentialPrompt />)

    const pending = getServices()
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await submitToken(ROOT_TOKEN)

    await expect(pending).resolves.toEqual(SERVICES)
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    // The retry carried the session token, never the root token.
    const services = calls.filter((call) => call.url.endsWith('/v1/services'))
    expect(services).toHaveLength(2)
    expect(services[0].authorization).toBeNull()
    expect(services[1].authorization).toBe(`Bearer ${SESSION_TOKEN}`)
  })

  it('tells the operator where the token lives and what happens to it', async () => {
    render(<CredentialPrompt />)
    void getServices().catch(() => undefined)

    const dialog = await screen.findByRole('dialog')

    expect(dialog).toHaveTextContent('~/.lem/api_token')
    expect(dialog).toHaveTextContent(/exchanged for a temporary session token and is not stored/i)
  })

  // The most likely bug in this feature: the dashboard fires several requests
  // at once, so a naive implementation prompts once per in-flight request.
  it('raises exactly one prompt and one exchange for concurrent 401s', async () => {
    render(<CredentialPrompt />)

    const pending = [getServices(), getServices(), getServices()]
    await screen.findByRole('dialog')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)

    await submitToken(ROOT_TOKEN)

    await expect(Promise.all(pending)).resolves.toEqual([SERVICES, SERVICES, SERVICES])
    expect(sessionExchanges()).toHaveLength(1)
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  it('stores the session token in sessionStorage by default', async () => {
    render(<CredentialPrompt />)
    const pending = getServices()

    await screen.findByRole('dialog')
    await submitToken(ROOT_TOKEN)
    await pending

    expect(window.sessionStorage.getItem(SESSION_STORAGE_KEY)).toBe(SESSION_TOKEN)
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
  })

  it('promotes the session token to localStorage only with the opt-in', async () => {
    render(<CredentialPrompt />)
    const pending = getServices()

    await screen.findByRole('dialog')
    await submitToken(ROOT_TOKEN, true)
    await pending

    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBe(SESSION_TOKEN)
    expect(window.sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
  })

  it('never stores the root token anywhere', async () => {
    render(<CredentialPrompt />)
    const pending = getServices()

    await screen.findByRole('dialog')
    await submitToken(ROOT_TOKEN, true)
    await pending

    const stored = [...storedValues(window.localStorage), ...storedValues(window.sessionStorage)]
    expect(stored.join(' ')).not.toContain(ROOT_TOKEN)
    // It went to the exchange endpoint and nowhere else.
    expect(sessionExchanges()).toHaveLength(1)
    expect(calls.filter((call) => call.authorization === `Bearer ${ROOT_TOKEN}`)).toHaveLength(1)
  })

  it('clears an expired session and re-prompts', async () => {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, 'expired-session-token')
    render(<CredentialPrompt />)

    const pending = getServices()
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    // The dead token is dropped before the prompt resolves, so nothing can
    // retry with it.
    expect(window.sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()

    await submitToken(ROOT_TOKEN)

    await expect(pending).resolves.toEqual(SERVICES)
    expect(window.sessionStorage.getItem(SESSION_STORAGE_KEY)).toBe(SESSION_TOKEN)
  })

  it('surfaces a rejected token without closing the prompt', async () => {
    render(<CredentialPrompt />)
    const pending = getServices()

    await screen.findByRole('dialog')
    await submitToken('the-wrong-token')

    expect(await screen.findByRole('alert')).toHaveTextContent(/was not accepted/i)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // The rejected value did not stay in the field.
    expect(screen.getByLabelText('API token')).toHaveValue('')

    // The request is still waiting, and a correct token still rescues it.
    await submitToken(ROOT_TOKEN)
    await expect(pending).resolves.toEqual(SERVICES)
  })

  it('lets the original 401 through when the operator dismisses the prompt', async () => {
    render(<CredentialPrompt />)
    // The rejection assertion is attached before the click, not after: the
    // promise is live across several awaits and an unhandled rejection in that
    // window is reported as a test-run error.
    const rejected = expect(getServices()).rejects.toThrow(ApiError)

    await screen.findByRole('dialog')
    await user().click(screen.getByRole('button', { name: 'Close' }))

    await rejected
    expect(sessionExchanges()).toHaveLength(0)
  })

  it('stays out of the way when the API needs no credential', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(200, SERVICES)))
    )
    render(<CredentialPrompt />)

    await expect(getServices()).resolves.toEqual(SERVICES)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

/**
 * Sign-out: the off switch for "remember on this device".
 *
 * Without it the opt-in is one-way - tick the box on a borrowed machine and the
 * credential stays in localStorage with no in-product way to remove it.
 */
describe('SessionStatus', () => {
  beforeEach(() => {
    calls = []
    resetCredentialState()
    window.sessionStorage.clear()
    window.localStorage.clear()
    installFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function renderDashboard(): void {
    render(
      <>
        <CredentialPrompt />
        <SessionStatus />
      </>
    )
  }

  it('offers nothing to sign out of when no credential is held', () => {
    renderDashboard()

    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument()
  })

  it('clears both storages on sign-out and prompts again on the next request', async () => {
    renderDashboard()

    // Take the remembered path, so the token lands in localStorage - the one
    // that survives a tab close and needs an explicit way out.
    const first = getServices()
    await screen.findByRole('dialog')
    await submitToken(ROOT_TOKEN, true)
    await expect(first).resolves.toEqual(SERVICES)
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBe(SESSION_TOKEN)

    await user().click(await screen.findByRole('button', { name: /sign out/i }))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument()
    })
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
    expect(window.sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
    expect(
      calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/v1/auth/session'))
    ).toBe(true)

    // The credential really is gone: the next call has to ask for one again.
    const second = getServices()
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await submitToken(ROOT_TOKEN)
    await expect(second).resolves.toEqual(SERVICES)
  })

  it('clears the credential even when the revoke call fails', async () => {
    // The worst outcome would be a sign-out that leaves the token behind
    // because the server had already restarted or the network was down.
    window.localStorage.setItem(SESSION_STORAGE_KEY, SESSION_TOKEN)
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down')))
    )
    renderDashboard()

    await user().click(await screen.findByRole('button', { name: /sign out/i }))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument()
    })
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
    expect(window.sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
  })

  it('re-prompts with "remember" unticked after a remembered session is signed out', async () => {
    renderDashboard()

    const first = getServices()
    await screen.findByRole('dialog')
    await submitToken(ROOT_TOKEN, true)
    await expect(first).resolves.toEqual(SERVICES)

    await user().click(await screen.findByRole('button', { name: /sign out/i }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument()
    })

    const second = getServices()
    await screen.findByRole('dialog')

    // The earlier tick must not carry into the next credential.
    expect(screen.getByRole('checkbox', { name: /remember on this device/i })).not.toBeChecked()
    await submitToken(ROOT_TOKEN)
    await expect(second).resolves.toEqual(SERVICES)
    expect(window.sessionStorage.getItem(SESSION_STORAGE_KEY)).toBe(SESSION_TOKEN)
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
  })
})
