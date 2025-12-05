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
 * Hook for fetching services via proxyFetch with polling.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Service } from '../api/types'

const LOCAL_API = 'http://localhost:5142'
const POLL_INTERVAL = 5000 // 5 seconds

interface UseServicesOptions {
  proxyFetch: (url: string, init?: RequestInit) => Promise<Response>
  enabled?: boolean
}

interface UseServicesResult {
  services: Service[]
  isLoading: boolean
  error: Error | null
  refetch: () => Promise<void>
}

export function useServices(options: UseServicesOptions): UseServicesResult {
  const { proxyFetch, enabled = true } = options
  const [services, setServices] = useState<Service[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const intervalRef = useRef<number | null>(null)
  const mountedRef = useRef(true)

  const fetchServices = useCallback(async () => {
    if (!enabled) return

    try {
      const response = await proxyFetch(`${LOCAL_API}/v1/services`)

      if (!mountedRef.current) return

      if (!response.ok) {
        throw new Error(`Failed to fetch services: ${response.status}`)
      }

      const data = (await response.json()) as Service[]
      setServices(data)
      setError(null)
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err : new Error('Unknown error'))
    } finally {
      if (mountedRef.current) {
        setIsLoading(false)
      }
    }
  }, [proxyFetch, enabled])

  // Initial fetch
  useEffect(() => {
    mountedRef.current = true

    if (enabled) {
      setIsLoading(true)
      fetchServices()
    }

    return () => {
      mountedRef.current = false
    }
  }, [fetchServices, enabled])

  // Polling
  useEffect(() => {
    if (!enabled) return

    intervalRef.current = window.setInterval(fetchServices, POLL_INTERVAL)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [fetchServices, enabled])

  return { services, isLoading, error, refetch: fetchServices }
}
