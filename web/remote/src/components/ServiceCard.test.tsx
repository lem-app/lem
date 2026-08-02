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
 * Degraded mode keeps the control plane (spec section 3.9 point 3).
 *
 * When the Service Worker is unavailable - the LAN case,
 * `http://<lan-ip>:5173`, which is not a secure context - the *only* thing that
 * may stop working is framing an app. Install, start, stop and remove all go
 * over `proxyFetch` on the page and never touch the worker, so degraded mode
 * must be no worse than the status quo before any of this existed.
 *
 * That is currently true by construction: `isDisabled` is
 * `isActionLoading || hasActiveJob` and has nothing to do with the worker. It
 * is exactly the kind of "true by construction" that a later refactor breaks by
 * folding one more condition into a shared flag, so it is pinned here.
 *
 * The other half of the criterion - that a browser at `http://<lan-ip>:5173`
 * really does report `isSecureContext === false` - is a fact about browsers
 * that jsdom cannot settle. `docs/testing_checklist.md` section 4.2 carries the
 * manual procedure.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ServiceCard } from './ServiceCard'
import { swUnavailableMessage } from '../lib/sw-status'
import type { JobResponse, Service } from '../api/types'

function runningService(): Service {
  return {
    id: 'openwebui',
    name: 'Open WebUI',
    category: 'frontend',
    description: 'A chat front end.',
    status: 'running',
    host_port: 33801,
    endpoint: 'http://127.0.0.1:33801',
    tags: [],
    depends_on: [],
    has_api: true,
    has_ui: true,
  }
}

function renderCard(overrides: { launchBlockedReason?: string | null } = {}) {
  const onStop = vi.fn<(serviceId: string) => Promise<void>>().mockResolvedValue(undefined)
  const onLaunch = vi.fn<(serviceId: string) => void>()

  render(
    <ServiceCard
      service={runningService()}
      proxyFetch={vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()}
      onInstall={vi.fn<(serviceId: string) => Promise<JobResponse>>()}
      onStart={vi.fn<(serviceId: string) => Promise<void>>().mockResolvedValue(undefined)}
      onStop={onStop}
      onRemove={vi.fn<(serviceId: string) => Promise<JobResponse>>()}
      onLaunch={onLaunch}
      launchBlockedReason={overrides.launchBlockedReason ?? null}
      isActionLoading={false}
    />
  )

  return { onStop, onLaunch }
}

describe('ServiceCard when the same-origin proxy is unavailable', () => {
  const reason = swUnavailableMessage('insecure-context')

  it('disables Launch and names the reason and the fix in the tooltip', () => {
    renderCard({ launchBlockedReason: reason })

    const launch = screen.getByRole('button', { name: /launch/i })

    expect(launch).toBeDisabled()
    // Section 3.9 point 2: "unavailable" alone sends the user hunting for a Lem
    // bug, so the tooltip has to say what to do instead.
    expect(launch).toHaveAttribute('title', reason)
    expect(reason).toMatch(/HTTPS|localhost/)
  })

  it('leaves Stop working, because the control plane does not use the worker', async () => {
    const { onStop } = renderCard({ launchBlockedReason: reason })

    const stop = screen.getByRole('button', { name: /stop/i })
    expect(stop).toBeEnabled()

    await userEvent.click(stop)

    expect(onStop).toHaveBeenCalledWith('openwebui')
  })

  it('enables Launch again when the proxy is available', () => {
    const { onLaunch } = renderCard({ launchBlockedReason: null })

    const launch = screen.getByRole('button', { name: /launch/i })

    expect(launch).toBeEnabled()
    expect(launch).not.toHaveAttribute('title')
    expect(onLaunch).not.toHaveBeenCalled()
  })
})
