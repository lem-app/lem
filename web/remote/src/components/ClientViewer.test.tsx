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
 * The viewer must never hand this browser a far-machine address.
 *
 * The old allowlist (F-SEC-3) restricted `<iframe src>` to loopback URLs, which
 * kept a compromised server from framing arbitrary content but still pointed the
 * frame at *this* browser's own localhost - defect #1 of issue #6. These tests
 * assert the stronger property that replaced it: the src is a same-origin
 * `/app/<deviceId>/<serviceId>/` path, whatever the server reports.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ClientViewer } from './ClientViewer'
import type { SessionRegistrar, SwStatus } from '../lib/sw-bridge'
import type { Service } from '../api/types'

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

function fakeBridge(): SessionRegistrar & {
  opened: [string, string][]
  closed: [string, string][]
} {
  const opened: [string, string][] = []
  const closed: [string, string][] = []
  return {
    opened,
    closed,
    openSession: (deviceId, serviceId) => {
      opened.push([deviceId, serviceId])
      return Promise.resolve()
    },
    closeSession: (deviceId, serviceId) => closed.push([deviceId, serviceId]),
  }
}

/** A worker that never acknowledges, as a wedged one would not. */
function silentBridge(): SessionRegistrar {
  return {
    openSession: () => Promise.reject(new Error('The Lem service worker did not acknowledge')),
    closeSession: () => undefined,
  }
}

const READY: SwStatus = { state: 'ready' }

function renderViewer(
  endpoint: string | null,
  bridge: SessionRegistrar | null,
  swStatus: SwStatus = READY
) {
  return render(
    <ClientViewer
      serviceId="webui"
      deviceId="dev-7f3a"
      connectionState="connected"
      dataChannelState="open"
      onBack={() => undefined}
      proxyFetch={proxyFetchReturning(service(endpoint))}
      swStatus={swStatus}
      bridge={bridge}
    />
  )
}

async function findFrame(): Promise<HTMLIFrameElement> {
  return await waitFor(() => {
    const element = document.querySelector('iframe')
    expect(element).not.toBeNull()
    return element as HTMLIFrameElement
  })
}

// Defect #1 of issue #6 was the iframe pointing at the remote browser's own
// loopback. The *other* half of that issue was the UI asserting the opposite of
// what the build did. Both halves regress the same way - quietly, in a string -
// so the claim is pinned here rather than left to review.
describe('what ClientViewer tells the user about the tunnel', () => {
  async function noteText(): Promise<string> {
    await findFrame()
    return document.body.textContent ?? ''
  }

  it('does not claim that everything is routed through a secure tunnel', async () => {
    renderViewer('http://localhost:3000/', fakeBridge())

    const text = await noteText()

    // The exact claim the spec called out, and the shapes it mutates into.
    expect(text).not.toMatch(/secure WebRTC tunnel/i)
    expect(text).not.toMatch(/all (HTTP )?requests/i)
    expect(text).not.toMatch(/all connections/i)
  })

  it('says the relay can see the traffic, because it can', async () => {
    renderViewer('http://localhost:3000/', fakeBridge())

    const text = await noteText()

    expect(text).toMatch(/relay/i)
    expect(text).toMatch(/terminates encryption/i)
  })

  // Presence-plus-scope tied to an issue number, so that closing #72 makes this
  // stale rather than leaving a claim that is simply false.
  it('says cookies are held per service rather than by the browser, and cites #72', async () => {
    renderViewer('http://localhost:3000/', fakeBridge())

    const text = await noteText()

    expect(text).toMatch(/kept per service/i)
    // The cost has to travel with the capability, or the note overclaims: the
    // app's own JavaScript still cannot read these cookies, and no real sign-in
    // has been confirmed end to end.
    expect(text).toMatch(/will not find it/i)
    expect(text).toMatch(/not yet been confirmed/i)
    expect(text).toContain('#72')
  })

  // Cross-origin URLs are deliberately not intercepted (spec 3.8), so a user
  // must not be told their third-party traffic goes via their device.
  it('says third-party resources are fetched by this browser directly', async () => {
    renderViewer('http://localhost:3000/', fakeBridge())

    const text = await noteText()

    expect(text).toMatch(/directly by this browser/i)
  })
})

describe('ClientViewer iframe', () => {
  it('frames the same-origin app path, not the service endpoint', async () => {
    renderViewer('http://localhost:3000/', fakeBridge())

    const frame = await findFrame()

    expect(frame.getAttribute('src')).toBe('/app/dev-7f3a/webui/')
    // The resolved URL stays on the dashboard's own origin, which is what lets
    // the Service Worker control the document at all.
    expect(new URL(frame.src, window.location.href).origin).toBe(window.location.origin)
  })

  it('ignores a hostile endpoint entirely rather than validating it', async () => {
    renderViewer('https://evil.example.com/', fakeBridge())

    const frame = await findFrame()

    expect(frame.getAttribute('src')).toBe('/app/dev-7f3a/webui/')
    expect(document.body.innerHTML).not.toContain('evil.example.com')
  })

  it('keeps the tight sandbox', async () => {
    renderViewer('http://localhost:3000/', fakeBridge())

    const frame = await findFrame()

    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-popups')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation')
  })

  it('does not suppress the referrer, which resolution step 2 reads', async () => {
    renderViewer('http://localhost:3000/', fakeBridge())

    const frame = await findFrame()

    // The frame is same-origin now, so the default policy sends the full path
    // and the worker can attribute a subresource from the referrer alone.
    expect(frame.getAttribute('referrerpolicy')).toBeNull()
  })

  it('registers the session before the frame exists, and closes it on unmount', async () => {
    const bridge = fakeBridge()
    const view = renderViewer('http://localhost:3000/', bridge)

    await findFrame()
    expect(bridge.opened).toEqual([['dev-7f3a', 'webui']])
    expect(bridge.closed).toEqual([])

    view.unmount()
    expect(bridge.closed).toEqual([['dev-7f3a', 'webui']])
  })

  it('renders no iframe until the worker acknowledges the session', async () => {
    render(
      <ClientViewer
        serviceId="webui"
        deviceId="dev-7f3a"
        connectionState="connected"
        dataChannelState="open"
        onBack={() => undefined}
        proxyFetch={proxyFetchReturning(service('http://localhost:3000/'))}
        swStatus={READY}
        bridge={silentBridge()}
      />
    )

    expect(await screen.findByText(/did not acknowledge/)).toBeInTheDocument()
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('renders no iframe at all when the proxy is unavailable', async () => {
    renderViewer('http://localhost:3000/', null, {
      state: 'unavailable',
      reason: 'insecure-context',
    })

    expect(await screen.findByText(/Cannot open Open WebUI here/)).toBeInTheDocument()
    // Never a fallback to the service's own address: that is the defect.
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('refuses to build a path from an id that would not survive the URL', async () => {
    const bridge = fakeBridge()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ClientViewer
        serviceId="../../etc"
        deviceId="dev-7f3a"
        connectionState="connected"
        dataChannelState="open"
        onBack={() => undefined}
        proxyFetch={proxyFetchReturning(service('http://localhost:3000/'))}
        swStatus={READY}
        bridge={bridge}
      />
    )

    expect(await screen.findByText(/cannot appear in a service URL/)).toBeInTheDocument()
    expect(document.querySelector('iframe')).toBeNull()
    expect(bridge.opened).toEqual([])
    consoleError.mockRestore()
  })
})
