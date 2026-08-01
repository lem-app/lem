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
 * Client viewer component.
 *
 * Frames a service at a **same-origin** path, `/app/<deviceId>/<serviceId>/`,
 * where a Service Worker intercepts every request the framed app makes and
 * performs it over the tunnel.
 *
 * The service's own address - `http://127.0.0.1:33801` and the like - is never
 * given to this browser as a URL to load. It is a *local-machine* address: put
 * it in an `<iframe src>` on a remote browser and the browser resolves it
 * against its own loopback, which is the whole of defect #1 in issue #6. The
 * address is used only on the far side, by the router, to pick an upstream.
 */

import { type ReactElement, type SyntheticEvent, useCallback, useEffect, useState } from 'react'
import type { ConnectionState, DataChannelState, Service } from '../api/types'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ArrowLeft, Activity, AlertCircle, Loader2 } from 'lucide-react'
import { localApiUrl } from '../lib/env'
import { appPath, type SessionRegistrar, type SwStatus } from '../lib/sw-bridge'
import { swUnavailableMessage } from '../lib/sw-status'
import { attachWsBridgeToFrame } from '../lib/ws-bridge'

interface Client {
  id: string
  name: string
  status: 'running' | 'stopped'
  url: string | null
}

// Unified app info for both clients and services
interface AppInfo {
  id: string
  name: string
  status: 'running' | 'stopped' | 'not_installed' | 'error'
  url: string | null
}

interface ClientViewerProps {
  clientId?: string
  serviceId?: string
  /** The device the tunnel is connected to; the first path segment. */
  deviceId: string
  connectionState: ConnectionState
  dataChannelState: DataChannelState
  onBack: () => void
  proxyFetch: (url: string, init?: RequestInit) => Promise<Response>
  /** Whether the same-origin proxy is usable, and why not when it is not. */
  swStatus: SwStatus
  /** Registers the service session before the frame is created. */
  bridge: SessionRegistrar | null
}

export function ClientViewer({
  clientId,
  serviceId,
  deviceId,
  connectionState,
  dataChannelState,
  onBack,
  proxyFetch,
  swStatus,
  bridge,
}: ClientViewerProps): ReactElement {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [frameSrc, setFrameSrc] = useState<string | null>(null)

  const isConnected = connectionState === 'connected' && dataChannelState === 'open'
  const appId = serviceId || clientId

  // Fetch app information (client or service)
  useEffect(() => {
    if (!isConnected) {
      setLoading(true)
      return
    }

    const fetchAppInfo = async () => {
      try {
        setLoading(true)
        setErrorMessage(null)

        if (serviceId) {
          // Fetch service info
          const response = await proxyFetch(localApiUrl(`/v1/services/${serviceId}`))

          if (!response.ok) {
            throw new Error(`Failed to fetch service: ${response.status}`)
          }

          const service = (await response.json()) as Service
          setAppInfo({
            id: service.id,
            name: service.name,
            status: service.status,
            url: service.endpoint,
          })
        } else if (clientId) {
          // Fetch client info (legacy)
          const response = await proxyFetch(localApiUrl('/v1/clients'))

          if (!response.ok) {
            throw new Error(`Failed to fetch clients: ${response.status}`)
          }

          const clients = (await response.json()) as Client[]
          const client = clients.find((c) => c.id === clientId)

          if (!client) {
            throw new Error(`Client '${clientId}' not found`)
          }

          setAppInfo({
            id: client.id,
            name: client.name,
            status: client.status,
            url: client.url,
          })
        }
      } catch (error) {
        console.error('[ClientViewer] Error fetching app info:', error)
        setErrorMessage(error instanceof Error ? error.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    void fetchAppInfo()
  }, [isConnected, clientId, serviceId, proxyFetch])

  // Register the session, wait for the worker to acknowledge it, and only then
  // build the frame URL. Strictly in that order: a `postMessage` to the worker
  // and a navigation into its scope are independent queues, so a frame created
  // optimistically can have its first request answered 410 by a worker that has
  // not been told about the session yet.
  useEffect(() => {
    if (bridge === null || appId === undefined) return
    if (appInfo?.status !== 'running') return

    let path: string
    try {
      path = appPath(deviceId, appId)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
      return
    }

    let cancelled = false
    bridge
      .openSession(deviceId, appId)
      .then(() => {
        if (!cancelled) setFrameSrc(path)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : String(error))
        }
      })

    return () => {
      cancelled = true
      setFrameSrc(null)
      bridge.closeSession(deviceId, appId)
    }
  }, [bridge, deviceId, appId, appInfo?.status])

  // Belt and braces only (spec section 3.7 step 4). By `load` the app has
  // already opened its first socket, so the shim's own `window.parent` lookup
  // is what actually has to work; this covers a dashboard that is itself framed
  // and whose parent is therefore somebody else.
  const handleFrameLoad = useCallback((event: SyntheticEvent<HTMLIFrameElement>) => {
    attachWsBridgeToFrame(event.currentTarget, window)
  }, [])

  const getStatusBadge = () => {
    if (!isConnected || loading) {
      return (
        <Badge variant="secondary" className="gap-1">
          <Activity className="h-3 w-3" />
          Loading...
        </Badge>
      )
    }

    if (!appInfo) {
      return (
        <Badge variant="destructive" className="gap-1">
          <AlertCircle className="h-3 w-3" />
          Not Found
        </Badge>
      )
    }

    if (appInfo.status === 'running') {
      return (
        <Badge variant="default" className="gap-1">
          <div className="h-2 w-2 rounded-full bg-green-500" />
          Running
        </Badge>
      )
    }

    if (appInfo.status === 'not_installed') {
      return (
        <Badge variant="outline" className="gap-1">
          <AlertCircle className="h-3 w-3" />
          Not Installed
        </Badge>
      )
    }

    return (
      <Badge variant="secondary" className="gap-1">
        <AlertCircle className="h-3 w-3" />
        Stopped
      </Badge>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button onClick={onBack} variant="ghost" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Dashboard
            </Button>
            <div className="h-6 w-px bg-border" />
            <div>
              <h1 className="text-xl font-bold">{appInfo?.name || appId}</h1>
              <p className="text-sm text-muted-foreground">
                {serviceId ? 'Service' : 'Client'} ID: {appId}
              </p>
            </div>
          </div>
          {getStatusBadge()}
        </div>
      </header>

      {/* Content */}
      <div className="container mx-auto p-6">
        {!isConnected && (
          <Alert>
            <Activity className="h-4 w-4" />
            <AlertDescription>Establishing connection to local device...</AlertDescription>
          </Alert>
        )}

        {isConnected && loading && (
          <Card>
            <CardContent className="flex items-center justify-center py-12">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Loading {serviceId ? 'service' : 'client'} information...
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {isConnected && !loading && errorMessage && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <strong>Error:</strong> {errorMessage}
            </AlertDescription>
          </Alert>
        )}

        {isConnected &&
          !loading &&
          appInfo &&
          (appInfo.status === 'stopped' || appInfo.status === 'not_installed') && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertCircle className="h-5 w-5 text-destructive" />
                  {serviceId ? 'Service' : 'Client'} Not Running
                </CardTitle>
                <CardDescription>
                  <strong>{appInfo.name}</strong> is currently{' '}
                  {appInfo.status === 'not_installed' ? 'not installed' : 'stopped'}.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-lg bg-muted p-4">
                  <p className="text-sm">
                    <strong>To access this {serviceId ? 'service' : 'client'}:</strong>
                  </p>
                  <ol className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {appInfo.status === 'not_installed' && (
                      <li>1. Install the service from the Service Catalog</li>
                    )}
                    <li>
                      {appInfo.status === 'not_installed' ? '2' : '1'}. Start the{' '}
                      {serviceId ? 'service' : 'client'} from the dashboard
                    </li>
                    <li>
                      {appInfo.status === 'not_installed' ? '3' : '2'}. Wait for it to initialize
                      (~30 seconds)
                    </li>
                    <li>
                      {appInfo.status === 'not_installed' ? '4' : '3'}. Click "Back to Dashboard"
                      and launch again
                    </li>
                  </ol>
                </div>
              </CardContent>
            </Card>
          )}

        {isConnected &&
          !loading &&
          !errorMessage &&
          appInfo?.status === 'running' &&
          swStatus.state === 'pending' && (
            <Card>
              <CardContent className="flex items-center justify-center py-12">
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Preparing the secure app proxy...</p>
                </div>
              </CardContent>
            </Card>
          )}

        {isConnected &&
          !loading &&
          appInfo &&
          appInfo.status === 'running' &&
          swStatus.state === 'unavailable' && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                <strong>Cannot open {appInfo.name} here.</strong>{' '}
                {swUnavailableMessage(swStatus.reason)} Installing, starting and stopping services
                still work.
              </AlertDescription>
            </Alert>
          )}

        {isConnected && !loading && appInfo && appInfo.status === 'running' && frameSrc && (
          <Card>
            <CardHeader>
              <CardTitle>{serviceId ? 'Service' : 'Client'} Interface</CardTitle>
              <CardDescription>
                Accessing <strong>{appInfo.name}</strong> on device{' '}
                <code className="break-all">{deviceId}</code>.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/*
                The src is same-origin by construction, which is what lets a
                Service Worker control the document and proxy every request it
                makes. It also means `allow-same-origin` + `allow-scripts` is
                not a boundary: the framed document shares this origin and can
                reach `parent.document`. The sandbox attribute restrains
                well-behaved apps only - see the tunnel proxy spec, section 8.4.
                `allow-popups` and `allow-top-navigation` stay off, and
                `allow=""` drops every powerful feature (camera, mic, ...).
              */}
              <div className="rounded-lg border bg-background">
                <iframe
                  src={frameSrc}
                  title={appInfo.name}
                  className="h-[calc(100vh-300px)] w-full rounded-lg"
                  sandbox="allow-scripts allow-same-origin allow-forms"
                  allow=""
                  onLoad={handleFrameLoad}
                />
              </div>

              <div className="mt-4 rounded-lg bg-muted p-3">
                <p className="text-xs text-muted-foreground">
                  <strong>Note:</strong> All HTTP requests and WebSocket connections are
                  automatically routed through the secure WebRTC tunnel to your local device.
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
