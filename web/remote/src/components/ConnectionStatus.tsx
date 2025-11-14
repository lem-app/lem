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
 * Connection status display component.
 */

import type { ReactElement } from 'react'
import type { ConnectionState, DataChannelState } from '../api/types'
import type { ConnectionMode } from '../hooks/useWebRTC'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'

type ConnectionStatusProps = {
  connectionState: ConnectionState
  dataChannelState: DataChannelState
  connectionMode: ConnectionMode
  error: Error | null
  onConnect: () => void
  onDisconnect: () => void
}

export function ConnectionStatus({
  connectionState,
  dataChannelState,
  connectionMode,
  error,
  onConnect,
  onDisconnect,
}: ConnectionStatusProps): ReactElement {
  const getConnectionStateVariant = (
    state: ConnectionState
  ): 'default' | 'secondary' | 'destructive' | 'outline' => {
    switch (state) {
      case 'connected':
        return 'default'
      case 'connecting':
        return 'secondary'
      case 'failed':
      case 'closed':
        return 'destructive'
      default:
        return 'outline'
    }
  }

  const getConnectionStateLabel = (state: ConnectionState, mode: ConnectionMode): string => {
    switch (state) {
      case 'connected':
        return mode === 'relay' ? 'Connected (Relay)' : 'Connected (P2P)'
      case 'connecting':
        return 'Connecting...'
      case 'failed':
        return 'Connection Failed'
      case 'closed':
        return 'Connection Closed'
      default:
        return 'Disconnected'
    }
  }

  const getConnectionModeLabel = (mode: ConnectionMode): string => {
    return mode === 'relay' ? 'Relay' : 'P2P (STUN)'
  }

  const getDataChannelStateVariant = (
    state: DataChannelState
  ): 'default' | 'secondary' | 'destructive' | 'outline' => {
    switch (state) {
      case 'open':
        return 'default'
      case 'connecting':
        return 'secondary'
      case 'closing':
      case 'closed':
        return 'destructive'
      default:
        return 'outline'
    }
  }

  return (
    <div className="p-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Connection Status</CardTitle>
            <div>
              {connectionState === 'disconnected' || connectionState === 'failed' ? (
                <Button onClick={onConnect} size="sm">
                  Connect
                </Button>
              ) : (
                <Button onClick={onDisconnect} variant="secondary" size="sm">
                  Disconnect
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">Connection Status</label>
              <div>
                <Badge variant={getConnectionStateVariant(connectionState)}>
                  {getConnectionStateLabel(connectionState, connectionMode)}
                </Badge>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Connection Mode</label>
              <div>
                <Badge variant={connectionMode === 'relay' ? 'secondary' : 'default'}>
                  {getConnectionModeLabel(connectionMode)}
                </Badge>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">DataChannel State</label>
              <div>
                <Badge variant={getDataChannelStateVariant(dataChannelState)}>
                  {dataChannelState}
                </Badge>
              </div>
            </div>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>
                <strong>Error:</strong> {error.message}
              </AlertDescription>
            </Alert>
          )}

          <Separator />

          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Diagnostics</h3>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <strong className="text-foreground">Signaling Server:</strong> ws://localhost:8000/signal
              </li>
              <li>
                <strong className="text-foreground">Connection Type:</strong>{' '}
                {connectionState === 'connected' ? getConnectionModeLabel(connectionMode) : 'Not connected'}
              </li>
              <li>
                <strong className="text-foreground">Protocol:</strong>{' '}
                {connectionMode === 'relay' ? 'WebSocket Relay' : 'WebRTC DataChannel'}
              </li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
