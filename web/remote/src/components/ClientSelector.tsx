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
 * Client selector component.
 *
 * Displays available client applications and allows user to select one to access.
 */

import { type ReactElement, useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Activity, AlertCircle, ExternalLink, Loader2 } from 'lucide-react'

interface Client {
  id: string
  name: string
  status: 'running' | 'stopped'
  url: string | null
}

interface ClientSelectorProps {
  proxyFetch: (url: string, init?: RequestInit) => Promise<Response>
  onSelectClient: (clientId: string) => void
}

export function ClientSelector({ proxyFetch, onSelectClient }: ClientSelectorProps): ReactElement {
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Fetch available clients
  useEffect(() => {
    const fetchClients = async () => {
      try {
        setLoading(true)
        setError(null)

        const response = await proxyFetch('http://localhost:5142/v1/clients')

        if (!response.ok) {
          throw new Error(`Failed to fetch clients: ${response.status}`)
        }

        const data = (await response.json()) as Client[]
        setClients(data)
      } catch (err) {
        console.error('[ClientSelector] Error fetching clients:', err)
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    fetchClients()
  }, [proxyFetch])

  const handleSelectClient = (client: Client) => {
    if (client.status !== 'running') {
      return
    }
    onSelectClient(client.id)
  }

  if (loading) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>Available Clients</CardTitle>
            <CardDescription>Loading available client applications...</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <strong>Error loading clients:</strong> {error}
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  if (clients.length === 0) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>No Clients Available</CardTitle>
            <CardDescription>No client applications are configured on the local device.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Client applications like Open WebUI can be managed through the local Lem server.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const runningClients = clients.filter((c) => c.status === 'running')
  const stoppedClients = clients.filter((c) => c.status === 'stopped')

  return (
    <div className="p-6">
      <Card>
        <CardHeader>
          <CardTitle>Available Clients</CardTitle>
          <CardDescription>Select a client application to access through the secure tunnel</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Running Clients */}
          {runningClients.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground">Running ({runningClients.length})</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {runningClients.map((client) => (
                  <Card
                    key={client.id}
                    className="cursor-pointer transition-all hover:border-primary hover:shadow-md"
                    onClick={() => handleSelectClient(client)}
                  >
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <CardTitle className="text-base">{client.name}</CardTitle>
                        <Badge variant="default" className="ml-2">
                          <div className="mr-1 h-2 w-2 rounded-full bg-green-500" />
                          Running
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <Button variant="outline" size="sm" className="w-full gap-2">
                        <ExternalLink className="h-4 w-4" />
                        Access Client
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Stopped Clients */}
          {stoppedClients.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-muted-foreground">Stopped ({stoppedClients.length})</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {stoppedClients.map((client) => (
                  <Card key={client.id} className="opacity-60">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <CardTitle className="text-base">{client.name}</CardTitle>
                        <Badge variant="secondary" className="ml-2">
                          <Activity className="mr-1 h-3 w-3" />
                          Stopped
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="text-xs text-muted-foreground">Start this client to access it remotely</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Info Box */}
          <div className="rounded-lg border bg-muted/50 p-4">
            <p className="text-xs text-muted-foreground">
              <strong>Note:</strong> All connections are routed through the secure WebRTC tunnel. HTTP requests and
              WebSocket connections are automatically proxied to your local device.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
