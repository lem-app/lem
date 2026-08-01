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
 * Hook for service operations (install/start/stop/remove) via proxyFetch.
 *
 * Pending state is tracked *per service*. A single shared `isLoading` disabled
 * every card in the catalog while one service was starting, which the local
 * dashboard already avoided.
 */

import { useState, useCallback } from 'react'
import type { JobResponse, StatusResponse } from '../api/types'
import { localApiUrl } from '../lib/env'

interface UseServiceActionsOptions {
  proxyFetch: (url: string, init?: RequestInit) => Promise<Response>
  onSuccess?: () => void
}

interface ErrorBody {
  detail?: unknown
}

async function readErrorDetail(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as ErrorBody
    return typeof body.detail === 'string' && body.detail.length > 0 ? body.detail : fallback
  } catch {
    return fallback
  }
}

export function useServiceActions(options: UseServiceActionsOptions) {
  const { proxyFetch, onSuccess } = options
  const [pendingServices, setPendingServices] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<Error | null>(null)

  const run = useCallback(
    async <T>(serviceId: string, action: string, label: string): Promise<T> => {
      setPendingServices((prev) => new Set(prev).add(serviceId))
      setError(null)

      try {
        const response = await proxyFetch(localApiUrl(`/v1/services/${serviceId}/${action}`), {
          method: 'POST',
        })

        if (!response.ok) {
          throw new Error(
            await readErrorDetail(response, `${label} failed: ${response.status.toString()}`)
          )
        }

        const result = (await response.json()) as T
        onSuccess?.()
        return result
      } catch (err) {
        const actionError = err instanceof Error ? err : new Error(`${label} failed`)
        setError(actionError)
        throw actionError
      } finally {
        setPendingServices((prev) => {
          const next = new Set(prev)
          next.delete(serviceId)
          return next
        })
      }
    },
    [proxyFetch, onSuccess]
  )

  const installService = useCallback(
    (serviceId: string) => run<JobResponse>(serviceId, 'install', 'Install'),
    [run]
  )

  const startService = useCallback(
    (serviceId: string) => run<StatusResponse>(serviceId, 'start', 'Start'),
    [run]
  )

  const stopService = useCallback(
    (serviceId: string) => run<StatusResponse>(serviceId, 'stop', 'Stop'),
    [run]
  )

  const removeService = useCallback(
    (serviceId: string) => run<JobResponse>(serviceId, 'remove', 'Remove'),
    [run]
  )

  const isServicePending = useCallback(
    (serviceId: string) => pendingServices.has(serviceId),
    [pendingServices]
  )

  return {
    error,
    isServicePending,
    installService,
    startService,
    stopService,
    removeService,
  }
}
