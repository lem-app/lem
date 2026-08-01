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
 * Tests for ServicesList job handling (F-COR-15, F-COR-16) and endpoint
 * link validation (F-SEC-5).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ServicesList } from './ServicesList'
import type { Job, Service } from '../api/types'

const client = vi.hoisted(() => ({
  getServices: vi.fn<() => Promise<Service[]>>(),
  installService: vi.fn<(id: string) => Promise<{ job_id: string }>>(),
  startService: vi.fn<(id: string) => Promise<{ status: 'ok' }>>(),
  stopService: vi.fn<(id: string) => Promise<{ status: 'ok' }>>(),
  removeService: vi.fn<(id: string) => Promise<{ job_id: string }>>(),
  getJob: vi.fn<(id: string) => Promise<Job>>(),
  getJobs: vi.fn<() => Promise<Job[]>>(),
}))

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return { ...actual, ...client }
})

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}))

function service(overrides: Partial<Service> = {}): Service {
  return {
    id: 'ollama',
    name: 'Ollama',
    category: 'backend',
    description: 'Local LLM runtime',
    status: 'not_installed',
    host_port: null,
    endpoint: null,
    tags: [],
    depends_on: [],
    has_api: true,
    has_ui: false,
    ...overrides,
  }
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: 'install',
    service_id: 'ollama',
    status: 'running',
    progress: 40,
    message: 'Pulling images',
    error: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:01Z',
    ...overrides,
  }
}

function renderList(): { queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  function Wrapper({ children }: { children: ReactNode }): ReactElement {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }

  render(<ServicesList />, { wrapper: Wrapper })
  return { queryClient }
}

describe('ServicesList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    client.getServices.mockResolvedValue([service()])
    client.getJobs.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders services from the catalog', async () => {
    expect(renderList().queryClient).toBeDefined()
    expect(await screen.findByText('Ollama')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Install' })).toBeInTheDocument()
  })

  it('shows job progress after starting an install', async () => {
    client.installService.mockResolvedValue({ job_id: 'job-1' })
    client.getJob.mockResolvedValue(job())

    renderList()
    await userEvent.click(await screen.findByRole('button', { name: 'Install' }))

    expect(await screen.findByText('Pulling images')).toBeInTheDocument()
    expect(await screen.findByText('40%')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Installing...' })).toBeInTheDocument()
  })

  // F-COR-15: setActiveJobId(null) used to run during render, and nothing
  // invalidated ["services"], so the card stayed "not installed" for up to 5s.
  it('refreshes the catalog when the job completes', async () => {
    client.installService.mockResolvedValue({ job_id: 'job-1' })
    client.getJob.mockResolvedValue(job({ status: 'completed', progress: 100 }))
    client.getServices.mockResolvedValueOnce([service()])
    client.getServices.mockResolvedValue([service({ status: 'running', endpoint: null })])

    renderList()
    await userEvent.click(await screen.findByRole('button', { name: 'Install' }))

    await waitFor(() => {
      expect(client.getServices.mock.calls.length).toBeGreaterThan(1)
    })
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument()
    // The completed job must not leave the progress bar behind.
    expect(screen.queryByText('Pulling images')).not.toBeInTheDocument()
  })

  // F-COR-16: a completed job left in the ["job", id] cache made the progress
  // bar skip straight past "running" on the next install.
  it('shows progress again when the same job id is tracked a second time', async () => {
    client.installService.mockResolvedValue({ job_id: 'job-1' })
    client.getJob.mockResolvedValueOnce(job({ status: 'completed', progress: 100 }))

    renderList()
    await userEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => {
      expect(client.getJob).toHaveBeenCalledTimes(1)
    })

    // Second attempt: the cache entry must have been dropped, so the hook
    // refetches rather than reading the completed job straight back.
    client.getJob.mockResolvedValue(job({ status: 'running', progress: 10 }))
    await userEvent.click(await screen.findByRole('button', { name: 'Install' }))

    expect(await screen.findByText('10%')).toBeInTheDocument()
  })

  it('surfaces a failed install without leaving the card stuck', async () => {
    client.installService.mockRejectedValue(new Error('boom'))

    renderList()
    await userEvent.click(await screen.findByRole('button', { name: 'Install' }))

    await waitFor(() => {
      expect(client.installService).toHaveBeenCalledTimes(1)
    })
    expect(await screen.findByRole('button', { name: 'Install' })).toBeEnabled()
  })

  // F-SEC-5
  it('links an http endpoint but not a javascript: one', async () => {
    client.getServices.mockResolvedValue([
      service({ id: 'a', name: 'Safe', status: 'running', endpoint: 'http://localhost:11434' }),
      service({
        id: 'b',
        name: 'Hostile',
        status: 'running',
        // Exactly the hostile input this test exists for.
        endpoint: 'javascript:alert(1)',
      }),
    ])

    renderList()

    const safeLink = await screen.findByRole('link', { name: 'http://localhost:11434' })
    expect(safeLink).toHaveAttribute('href', 'http://localhost:11434/')

    expect(await screen.findByText('javascript:alert(1)')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'javascript:alert(1)' })).not.toBeInTheDocument()
  })
})
