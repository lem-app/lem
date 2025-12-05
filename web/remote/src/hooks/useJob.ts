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
 * Hook for tracking job progress via proxyFetch with fast polling.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Job } from '../api/types'

const LOCAL_API = 'http://localhost:5142'
const FAST_POLL_INTERVAL = 1000 // 1 second while job active

interface UseJobOptions {
  proxyFetch: (url: string, init?: RequestInit) => Promise<Response>
  jobId: string | null
  onComplete?: (job: Job) => void
}

interface UseJobResult {
  job: Job | null
  isLoading: boolean
  error: Error | null
}

export function useJob(options: UseJobOptions): UseJobResult {
  const { proxyFetch, jobId, onComplete } = options
  const [job, setJob] = useState<Job | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const intervalRef = useRef<number | null>(null)
  const onCompleteRef = useRef(onComplete)
  const mountedRef = useRef(true)

  // Keep onComplete ref updated
  onCompleteRef.current = onComplete

  const fetchJob = useCallback(async () => {
    if (!jobId) return null

    try {
      const response = await proxyFetch(`${LOCAL_API}/v1/jobs/${jobId}`)

      if (!mountedRef.current) return null

      if (!response.ok) {
        throw new Error(`Failed to fetch job: ${response.status}`)
      }

      const data = (await response.json()) as Job
      setJob(data)
      setError(null)

      // Check if job completed
      if (data.status === 'completed' || data.status === 'failed') {
        onCompleteRef.current?.(data)
        // Stop polling
        if (intervalRef.current) {
          clearInterval(intervalRef.current)
          intervalRef.current = null
        }
      }

      return data
    } catch (err) {
      if (!mountedRef.current) return null
      setError(err instanceof Error ? err : new Error('Unknown error'))
      return null
    }
  }, [proxyFetch, jobId])

  useEffect(() => {
    mountedRef.current = true

    if (!jobId) {
      setJob(null)
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    fetchJob().finally(() => {
      if (mountedRef.current) {
        setIsLoading(false)
      }
    })

    // Start polling
    intervalRef.current = window.setInterval(fetchJob, FAST_POLL_INTERVAL)

    return () => {
      mountedRef.current = false
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [jobId, fetchJob])

  return { job, isLoading, error }
}
