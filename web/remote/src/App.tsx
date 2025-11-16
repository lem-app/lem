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
 * Main application component.
 */

import { useState, useEffect } from 'react'
import type { ReactElement } from 'react'
import { useAuth } from './hooks/useAuth'
import { useWebRTC } from './hooks/useWebRTC'
import { registerDevice } from './api/auth'
import { Login } from './components/Login'
import { DeviceSelector } from './components/DeviceSelector'
import { ConnectionStatus } from './components/ConnectionStatus'
import { APITester } from './components/APITester'
import { ClientViewer } from './components/ClientViewer'
import { ClientSelector } from './components/ClientSelector'
import { Button } from '@/components/ui/button'

const SIGNAL_URL = import.meta.env.VITE_SIGNAL_URL || 'ws://localhost:8000/signal'

// Generate a UUID v4-like string (fallback for non-secure contexts)
function generateUUID(): string {
  // Check if crypto.randomUUID is available (secure context)
  if (crypto.randomUUID) {
    return crypto.randomUUID()
  }

  // Fallback for non-secure contexts (HTTP on LAN)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// Generate a browser device ID (stored in localStorage)
function getBrowserDeviceId(): string {
  const stored = localStorage.getItem('browser_device_id')
  if (stored) return stored

  const newId = `browser-${generateUUID()}`
  localStorage.setItem('browser_device_id', newId)
  return newId
}

function App(): ReactElement {
  const { isAuthenticated, token, login, logout, isLoading, error: authError } = useAuth()
  const [targetDeviceId, setTargetDeviceId] = useState<string | null>(null)
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)

  const browserDeviceId = getBrowserDeviceId()

  const {
    connectionState,
    dataChannelState,
    connectionMode,
    error: webrtcError,
    connect,
    disconnect,
    proxyFetch,
  } = useWebRTC({
    signalUrl: SIGNAL_URL,
    token: token || '',
    deviceId: browserDeviceId,
    targetDeviceId: targetDeviceId || '',
    autoConnect: false,
    relayUrl: import.meta.env.VITE_RELAY_URL || 'ws://localhost:8001',
  })

  const handleDeviceSelect = (deviceId: string) => {
    setTargetDeviceId(deviceId)
  }

  const handleLogout = () => {
    disconnect()
    setTargetDeviceId(null)
    logout()
  }

  const handleSelectClient = (clientId: string) => {
    setSelectedClientId(clientId)
  }

  const handleBackFromClient = () => {
    setSelectedClientId(null)
  }

  const handleLogin = async (credentials: Parameters<typeof login>[0]) => {
    await login(credentials)
  }

  // Register browser device when authenticated
  useEffect(() => {
    if (isAuthenticated && token) {
      registerDevice(browserDeviceId, token).catch((err) => {
        console.error('Failed to register browser device:', err)
      })
    }
  }, [isAuthenticated, token, browserDeviceId])

  // Not authenticated - show login
  if (!isAuthenticated) {
    return <Login onLogin={handleLogin} isLoading={isLoading} error={authError} />
  }

  // Authenticated but no device selected
  if (!targetDeviceId) {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b bg-card px-6 py-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold">Lem Remote Access</h1>
            <Button onClick={handleLogout} variant="secondary" size="sm">
              Logout
            </Button>
          </div>
        </header>

        <div className="container mx-auto">
          <DeviceSelector onSelectDevice={handleDeviceSelect} token={token || ''} />
        </div>
      </div>
    )
  }

  // Authenticated and device selected - check if viewing a client
  if (selectedClientId && connectionState === 'connected' && (connectionMode === 'relay' || dataChannelState === 'open')) {
    return (
      <ClientViewer
        clientId={selectedClientId}
        connectionState={connectionState}
        dataChannelState={dataChannelState}
        onBack={handleBackFromClient}
        proxyFetch={proxyFetch}
      />
    )
  }

  // Authenticated and device selected - show connection status and client selector
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold">Lem Remote Access</h1>
            <p className="text-sm text-muted-foreground">
              Browser Device ID: <code className="rounded bg-muted px-1 py-0.5 text-xs">{browserDeviceId}</code>
            </p>
            <p className="text-sm text-muted-foreground">
              Target Device ID: <code className="rounded bg-muted px-1 py-0.5 text-xs">{targetDeviceId}</code>
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setTargetDeviceId(null)} variant="secondary" size="sm">
              Change Device
            </Button>
            <Button onClick={handleLogout} variant="secondary" size="sm">
              Logout
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto space-y-4 py-4">
        <ConnectionStatus
          connectionState={connectionState}
          dataChannelState={dataChannelState}
          connectionMode={connectionMode}
          error={webrtcError}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        {connectionState === 'connected' && (connectionMode === 'relay' || dataChannelState === 'open') && (
          <>
            <ClientSelector proxyFetch={proxyFetch} onSelectClient={handleSelectClient} />
            <APITester proxyFetch={proxyFetch} isConnected={true} />
          </>
        )}
      </div>
    </div>
  )
}

export default App
