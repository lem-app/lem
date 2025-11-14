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
import type { ConnectionState, DataChannelState } from '../api/types'
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

interface ClientViewerProps {
  clientId: string
  connectionState: ConnectionState
  dataChannelState: DataChannelState
  onBack: () => void
  proxyFetch: (url: string, init?: RequestInit) => Promise<Response>
}

export function ClientViewer({
  clientId,
  connectionState,
  dataChannelState,
  onBack,
  proxyFetch,
}: ClientViewerProps): ReactElement {
  const [clientInfo, setClientInfo] = useState<Client | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const isConnected = connectionState === 'connected' && dataChannelState === 'open'

  // Fetch client information
  useEffect(() => {
    if (!isConnected) {
      setLoading(true)
      return
    }

    const fetchClientInfo = async () => {
      try {
        setLoading(true)
        setErrorMessage(null)

        // Fetch all clients and find the one we want
        const response = await proxyFetch('http://localhost:5142/v1/clients')

        if (!response.ok) {
          throw new Error(`Failed to fetch clients: ${response.status}`)
        }

        const clients = (await response.json()) as Client[]
        const client = clients.find((c) => c.id === clientId)

        if (!client) {
          throw new Error(`Client '${clientId}' not found`)
        }

        setClientInfo(client)
      } catch (error) {
        console.error('[ClientViewer] Error fetching client:', error)
        setErrorMessage(error instanceof Error ? error.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    fetchClientInfo()
  }, [isConnected, clientId, proxyFetch])

  const getStatusBadge = () => {
    if (!isConnected || loading) {
      return (
        <Badge variant="secondary" className="gap-1">
          <Activity className="h-3 w-3" />
          Loading...
        </Badge>
      )
    }

    if (!clientInfo) {
      return (
        <Badge variant="destructive" className="gap-1">
          <AlertCircle className="h-3 w-3" />
          Not Found
        </Badge>
      )
    }

    if (clientInfo.status === 'running') {
      return (
        <Badge variant="default" className="gap-1">
          <div className="h-2 w-2 rounded-full bg-green-500" />
          Running
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
              <h1 className="text-xl font-bold">{clientInfo?.name || clientId}</h1>
              <p className="text-sm text-muted-foreground">Client ID: {clientId}</p>
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
                <p className="text-sm text-muted-foreground">Loading client information...</p>
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

        {isConnected && !loading && clientInfo && clientInfo.status === 'stopped' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-destructive" />
                Client Not Running
              </CardTitle>
              <CardDescription>
                The client <strong>{clientInfo.name}</strong> is currently stopped.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg bg-muted p-4">
                <p className="text-sm">
                  <strong>To access this client:</strong>
                </p>
                <ol className="mt-2 space-y-1 text-sm text-muted-foreground">
                  <li>1. Start the client through your local Lem server</li>
                  <li>2. Wait for the client to initialize (~30 seconds)</li>
                  <li>3. Click "Back to Dashboard" and select the client again</li>
                </ol>
              </div>
            </CardContent>
          </Card>
        )}

        {isConnected && !loading && clientInfo && clientInfo.status === 'running' && clientInfo.url && (
          <Card>
            <CardHeader>
              <CardTitle>Client Interface</CardTitle>
              <CardDescription>
                Accessing <strong>{clientInfo.name}</strong> at {clientInfo.url}. WebSocket connections are
                automatically proxied.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Client UI will be rendered here using iframe */}
              <div className="rounded-lg border bg-background">
                <iframe
                  src={clientInfo.url}
                  title={clientInfo.name}
                  className="h-[calc(100vh-300px)] w-full rounded-lg"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                />
              </div>

              <div className="mt-4 rounded-lg bg-muted p-3">
                <p className="text-xs text-muted-foreground">
                  <strong>Note:</strong> All HTTP requests and WebSocket connections are automatically routed through
                  the secure WebRTC tunnel to your local device.
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
