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
 */

import { useState, useCallback } from 'react'
import type { JobResponse, StatusResponse } from '../api/types'

const LOCAL_API = 'http://localhost:5142'

interface UseServiceActionsOptions {
  proxyFetch: (url: string, init?: RequestInit) => Promise<Response>
  onSuccess?: () => void
}

interface ServiceActionState {
  isLoading: boolean
  error: Error | null
}

export function useServiceActions(options: UseServiceActionsOptions) {
  const { proxyFetch, onSuccess } = options
  const [state, setState] = useState<ServiceActionState>({
    isLoading: false,
    error: null,
  })

  const installService = useCallback(
    async (serviceId: string): Promise<JobResponse> => {
      setState({ isLoading: true, error: null })
      try {
        const response = await proxyFetch(`${LOCAL_API}/v1/services/${serviceId}/install`, {
          method: 'POST',
        })
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          throw new Error(errorData.detail || `Install failed: ${response.status}`)
        }
        const result = (await response.json()) as JobResponse
        onSuccess?.()
        return result
      } catch (err) {
        const error = err instanceof Error ? err : new Error('Unknown error')
        setState({ isLoading: false, error })
        throw error
      } finally {
        setState((s) => ({ ...s, isLoading: false }))
      }
    },
    [proxyFetch, onSuccess]
  )

  const startService = useCallback(
    async (serviceId: string): Promise<StatusResponse> => {
      setState({ isLoading: true, error: null })
      try {
        const response = await proxyFetch(`${LOCAL_API}/v1/services/${serviceId}/start`, {
          method: 'POST',
        })
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          throw new Error(errorData.detail || `Start failed: ${response.status}`)
        }
        const result = (await response.json()) as StatusResponse
        onSuccess?.()
        return result
      } catch (err) {
        const error = err instanceof Error ? err : new Error('Unknown error')
        setState({ isLoading: false, error })
        throw error
      } finally {
        setState((s) => ({ ...s, isLoading: false }))
      }
    },
    [proxyFetch, onSuccess]
  )

  const stopService = useCallback(
    async (serviceId: string): Promise<StatusResponse> => {
      setState({ isLoading: true, error: null })
      try {
        const response = await proxyFetch(`${LOCAL_API}/v1/services/${serviceId}/stop`, {
          method: 'POST',
        })
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          throw new Error(errorData.detail || `Stop failed: ${response.status}`)
        }
        const result = (await response.json()) as StatusResponse
        onSuccess?.()
        return result
      } catch (err) {
        const error = err instanceof Error ? err : new Error('Unknown error')
        setState({ isLoading: false, error })
        throw error
      } finally {
        setState((s) => ({ ...s, isLoading: false }))
      }
    },
    [proxyFetch, onSuccess]
  )

  const removeService = useCallback(
    async (serviceId: string): Promise<JobResponse> => {
      setState({ isLoading: true, error: null })
      try {
        const response = await proxyFetch(`${LOCAL_API}/v1/services/${serviceId}/remove`, {
          method: 'POST',
        })
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          throw new Error(errorData.detail || `Remove failed: ${response.status}`)
        }
        const result = (await response.json()) as JobResponse
        onSuccess?.()
        return result
      } catch (err) {
        const error = err instanceof Error ? err : new Error('Unknown error')
        setState({ isLoading: false, error })
        throw error
      } finally {
        setState((s) => ({ ...s, isLoading: false }))
      }
    },
    [proxyFetch, onSuccess]
  )

  return {
    ...state,
    installService,
    startService,
    stopService,
    removeService,
  }
}
