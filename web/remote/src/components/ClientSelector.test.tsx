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
 * The second of the two tunnel claims (spec section 9, Phase 6).
 *
 * The spec warned that the notes here and in `ClientViewer` are near-duplicates
 * but **not** verbatim identical, and that fixing one by search-and-replace
 * would leave the other. This file exists so that reverting *this* component's
 * wording fails the suite on its own - a guard on `ClientViewer` alone would
 * have let exactly the half-fix the spec predicted through review.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ClientSelector } from './ClientSelector'

function renderSelector() {
  const clients = [{ id: 'openwebui', name: 'Open WebUI', status: 'running', url: null }]
  const proxyFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(
      new Response(JSON.stringify(clients), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  )

  render(<ClientSelector proxyFetch={proxyFetch} onSelectClient={vi.fn()} />)

  return waitFor(() => {
    expect(screen.getByText('Open WebUI')).toBeInTheDocument()
    return document.body.textContent ?? ''
  })
}

describe('what ClientSelector tells the user about the tunnel', () => {
  it('does not claim that all connections ride a secure tunnel', async () => {
    const text = await renderSelector()

    expect(text).not.toMatch(/secure WebRTC tunnel/i)
    expect(text).not.toMatch(/all connections/i)
    expect(text).not.toMatch(/all (HTTP )?requests/i)
  })

  it('keeps the relay caveat, which is the part that is actually a security claim', async () => {
    const text = await renderSelector()

    expect(text).toMatch(/relay/i)
    expect(text).toMatch(/terminates encryption/i)
  })

  it('says third-party resources are loaded by this browser, not via the device', async () => {
    const text = await renderSelector()

    // Cross-origin URLs are deliberately not intercepted (spec section 3.8).
    expect(text).toMatch(/third-party/i)
    expect(text).toMatch(/directly by this browser/i)
  })

  it('states the cookie limitation and cites #72', async () => {
    const text = await renderSelector()

    expect(text).toMatch(/cookies are not delivered to framed apps/i)
    expect(text).toContain('#72')
  })
})
