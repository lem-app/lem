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
 * Tests for the framed-app URL allowlist (F-SEC-3).
 */

import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ClientViewer } from './ClientViewer'
import { toFramableUrl } from '../lib/framable-url'
import type { Service } from '../api/types'

describe('toFramableUrl', () => {
  it('accepts loopback http(s) URLs', () => {
    expect(toFramableUrl('http://localhost:3000/')).toBe('http://localhost:3000/')
    expect(toFramableUrl('http://127.0.0.1:8080/ui')).toBe('http://127.0.0.1:8080/ui')
  })

  it('rejects javascript: and data: URLs', () => {
    expect(toFramableUrl('javascript:alert(1)')).toBeNull()
    expect(toFramableUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
  })

  it('rejects non-loopback hosts', () => {
    expect(toFramableUrl('https://evil.example.com/')).toBeNull()
    expect(toFramableUrl('http://10.0.0.5:3000/')).toBeNull()
  })

  it('rejects nonsense and empty values', () => {
    expect(toFramableUrl('not a url')).toBeNull()
    expect(toFramableUrl(null)).toBeNull()
    expect(toFramableUrl(undefined)).toBeNull()
    expect(toFramableUrl('')).toBeNull()
  })
})

function service(endpoint: string | null): Service {
  return {
    id: 'webui',
    name: 'Open WebUI',
    category: 'frontend',
    description: 'chat ui',
    status: 'running',
    host_port: 3000,
    endpoint,
    tags: [],
    depends_on: [],
    has_api: false,
    has_ui: true,
  }
}

function proxyFetchReturning(body: Service): (url: string) => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
}

describe('ClientViewer iframe', () => {
  it('embeds a loopback service with a tight sandbox', async () => {
    render(
      <ClientViewer
        serviceId="webui"
        connectionState="connected"
        dataChannelState="open"
        onBack={() => undefined}
        proxyFetch={proxyFetchReturning(service('http://localhost:3000/'))}
      />
    )

    const frame = await waitFor(() => {
      const el = document.querySelector('iframe')
      expect(el).not.toBeNull()
      return el
    })

    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms')
    // allow-popups and allow-top-navigation must stay off.
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-popups')
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-top-navigation')
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('refuses to embed a server-supplied non-loopback URL', async () => {
    render(
      <ClientViewer
        serviceId="webui"
        connectionState="connected"
        dataChannelState="open"
        onBack={() => undefined}
        proxyFetch={proxyFetchReturning(service('https://evil.example.com/'))}
      />
    )

    expect(await screen.findByText(/Refusing to embed/)).toBeInTheDocument()
    expect(document.querySelector('iframe')).toBeNull()
  })
})
