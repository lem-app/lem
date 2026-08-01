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
 * Owns the Service Worker proxy's lifecycle for the dashboard.
 */

import { useEffect, useRef, useState } from 'react'
import { ServiceWorkerBridge, type ProxyFetch, type SwStatus } from '../lib/sw-bridge'

interface UseAppProxyOptions {
  /** Performs one request over the tunnel. */
  proxyFetch: ProxyFetch
  /** Device the tunnel is connected to, or null when none is selected. */
  deviceId: string | null
  /** Whether the tunnel is currently usable. */
  tunnelUp: boolean
}

export interface AppProxy {
  status: SwStatus
  bridge: ServiceWorkerBridge | null
}

/**
 * Register the worker once, then keep it told about the device and the tunnel.
 *
 * Registration happens on mount rather than on launch: the worker only takes
 * control of a document on that document's *next* navigation, so registering
 * lazily when the user clicks Launch would leave the first iframe load
 * uncontrolled - and an uncontrolled `/app/…` load is a 404 against the
 * dashboard's own origin.
 */
export function useAppProxy({ proxyFetch, deviceId, tunnelUp }: UseAppProxyOptions): AppProxy {
  const [status, setStatus] = useState<SwStatus>({ state: 'pending' })
  const bridgeRef = useRef<ServiceWorkerBridge | null>(null)
  const [bridge, setBridge] = useState<ServiceWorkerBridge | null>(null)

  useEffect(() => {
    const instance = new ServiceWorkerBridge({ proxyFetch })
    bridgeRef.current = instance
    let cancelled = false

    instance
      .start()
      .then((result) => {
        if (cancelled) return
        setStatus(result)
        setBridge(result.state === 'ready' ? instance : null)
      })
      .catch((error: unknown) => {
        console.error('[useAppProxy] Service worker bridge failed:', error)
        if (!cancelled) setStatus({ state: 'unavailable', reason: 'registration-failed' })
      })

    return () => {
      cancelled = true
      instance.dispose()
      bridgeRef.current = null
    }
  }, [proxyFetch])

  useEffect(() => {
    if (bridge === null || deviceId === null) return
    bridge.setActiveDevice(deviceId)
  }, [bridge, deviceId])

  useEffect(() => {
    if (bridge === null) return
    bridge.setTunnelUp(tunnelUp)
  }, [bridge, tunnelUp])

  return { status, bridge }
}
