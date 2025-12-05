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
 * Displays a remote client application (like Open WebUI) through the WebRTC proxy.
 */

import { type ReactElement, useEffect, useState } from 'react'
import type { ConnectionState, DataChannelState, Service } from '../api/types'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ArrowLeft, Activity, AlertCircle, Loader2 } from 'lucide-react'

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
  connectionState: ConnectionState
  dataChannelState: DataChannelState
  onBack: () => void
  proxyFetch: (url: string, init?: RequestInit) => Promise<Response>
}

export function ClientViewer({
  clientId,
  serviceId,
  connectionState,
  dataChannelState,
  onBack,
  proxyFetch,
}: ClientViewerProps): ReactElement {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

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
          const response = await proxyFetch(`http://localhost:5142/v1/services/${serviceId}`)

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
          const response = await proxyFetch('http://localhost:5142/v1/clients')

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

    fetchAppInfo()
  }, [isConnected, clientId, serviceId, proxyFetch])

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

        {isConnected && !loading && appInfo && appInfo.status === 'running' && appInfo.url && (
          <Card>
            <CardHeader>
              <CardTitle>{serviceId ? 'Service' : 'Client'} Interface</CardTitle>
              <CardDescription>
                Accessing <strong>{appInfo.name}</strong> at {appInfo.url}. WebSocket connections
                are automatically proxied.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* App UI will be rendered here using iframe */}
              <div className="rounded-lg border bg-background">
                <iframe
                  src={appInfo.url}
                  title={appInfo.name}
                  className="h-[calc(100vh-300px)] w-full rounded-lg"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
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
