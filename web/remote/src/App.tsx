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
import { useAppProxy } from './hooks/useAppProxy'
import { swUnavailableMessage } from './lib/sw-status'
import { registerDevice } from './api/auth'
import { Login } from './components/Login'
import { DeviceSelector } from './components/DeviceSelector'
import { ConnectionStatus } from './components/ConnectionStatus'
import { APITester } from './components/APITester'
import { ClientViewer } from './components/ClientViewer'
import { ClientSelector } from './components/ClientSelector'
import { ServicesCatalog } from './components/ServicesCatalog'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { config, configError } from './lib/env'
import { readToken } from './lib/session'

// The browser's device id used to be minted here and kept in localStorage,
// separately from the (fake) `'browser-key'` it registered. It now comes from
// `api/device-key`, which stores the id alongside the Ed25519 key that owns
// it, so the two cannot drift apart.

type ViewMode = 'clients' | 'services'

/**
 * Rendered instead of the app when `lib/env.ts` rejects the build's endpoint
 * configuration. Failing visibly beats a dashboard that quietly dials localhost.
 */
function ConfigurationError({ message }: { message: string }): ReactElement {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Alert variant="destructive" className="max-w-2xl">
        <AlertDescription className="space-y-2">
          <p className="font-semibold">Lem Remote Access is misconfigured</p>
          <p className="text-sm">{message}</p>
          <p className="text-sm">
            Set the required <code>VITE_*</code> variables and rebuild. See{' '}
            <code>web/remote/.env.production.example</code>.
          </p>
        </AlertDescription>
      </Alert>
    </div>
  )
}

function App(): ReactElement {
  if (configError !== null || config === null) {
    return <ConfigurationError message={configError ?? 'Configuration could not be resolved.'} />
  }

  return (
    <Dashboard
      signalUrl={config.signalUrl}
      relayUrl={config.relayUrl}
      iceServers={config.iceServers}
    />
  )
}

interface DashboardProps {
  signalUrl: string
  relayUrl: string
  iceServers: RTCIceServer[]
}

function Dashboard({ signalUrl, relayUrl, iceServers }: DashboardProps): ReactElement {
  // No `token` here, deliberately: anything this component holds is reachable
  // from the DOM through React's fiber expandos, and ClientViewer's iframe is
  // a child of this tree. See useAuth's module comment and #82.
  const { isAuthenticated, login, logout, isLoading, error: authError } = useAuth()
  const [targetDeviceId, setTargetDeviceId] = useState<string | null>(null)
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('services')

  // Set once the browser's Ed25519 identity is registered with signaling.
  // Until then there is no device id to connect as, which is the point: an
  // unregistered browser has nothing to prove it is a device of this account.
  const [browserDeviceId, setBrowserDeviceId] = useState<string | null>(null)
  const [deviceKeyError, setDeviceKeyError] = useState<string | null>(null)

  const {
    connectionState,
    dataChannelState,
    connectionMode,
    error: webrtcError,
    connect,
    disconnect,
    proxyFetch,
  } = useWebRTC({
    signalUrl,
    authenticated: isAuthenticated,
    deviceId: browserDeviceId ?? '',
    targetDeviceId: targetDeviceId ?? '',
    autoConnect: false,
    relayUrl,
    // `config.iceServers` is built once at module load, so this reference is
    // stable across renders (useWebRTC keys an effect on it).
    iceServers,
  })

  const isTunnelUp =
    connectionState === 'connected' && (connectionMode === 'relay' || dataChannelState === 'open')

  const { status: swStatus, bridge } = useAppProxy({
    proxyFetch,
    deviceId: targetDeviceId,
    tunnelUp: isTunnelUp,
  })

  const launchBlockedReason =
    swStatus.state === 'unavailable' ? swUnavailableMessage(swStatus.reason) : null

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
    setSelectedServiceId(null)
  }

  const handleLaunchService = (serviceId: string) => {
    setSelectedServiceId(serviceId)
    setSelectedClientId(null)
  }

  const handleBackFromViewer = () => {
    setSelectedClientId(null)
    setSelectedServiceId(null)
  }

  const handleLogin = async (credentials: Parameters<typeof login>[0]): Promise<void> => {
    try {
      await login(credentials)
    } catch {
      // Already surfaced through `authError`; rethrowing here would only
      // produce an unhandled rejection from the form's submit handler.
    }
  }

  // Enrol this browser's Ed25519 device key once authenticated. The device id
  // is whatever the key store says it is, so it always matches the key that
  // signs for it.
  useEffect(() => {
    if (!isAuthenticated) return

    let cancelled = false
    // Read at the point of use, so the token is a local in this closure rather
    // than a value this component holds - see #82.
    const token = readToken()
    if (token === null) return

    registerDevice(token)
      .then((deviceId) => {
        if (!cancelled) {
          setBrowserDeviceId(deviceId)
          setDeviceKeyError(null)
        }
      })
      .catch((err: unknown) => {
        console.error('Failed to register browser device:', err)
        if (!cancelled) {
          setBrowserDeviceId(null)
          setDeviceKeyError(err instanceof Error ? err.message : 'Device registration failed')
        }
      })

    return () => {
      cancelled = true
    }
  }, [isAuthenticated])

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
          {deviceKeyError !== null && (
            <Alert variant="destructive" className="mx-6 mt-6">
              <AlertTitle>This browser could not register its device key</AlertTitle>
              <AlertDescription>
                {deviceKeyError} Remote connections stay disabled until this browser can prove it
                owns an Ed25519 device key.
              </AlertDescription>
            </Alert>
          )}
          <DeviceSelector onSelectDevice={handleDeviceSelect} />
        </div>
      </div>
    )
  }

  // Authenticated and device selected - check if viewing a client or service
  const isViewingApp = (selectedClientId || selectedServiceId) && isTunnelUp
  if (isViewingApp) {
    return (
      <ClientViewer
        clientId={selectedClientId ?? undefined}
        serviceId={selectedServiceId ?? undefined}
        deviceId={targetDeviceId}
        connectionState={connectionState}
        dataChannelState={dataChannelState}
        onBack={handleBackFromViewer}
        proxyFetch={proxyFetch}
        swStatus={swStatus}
        bridge={bridge}
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
              Browser Device ID:{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                {browserDeviceId ?? 'registering…'}
              </code>
            </p>
            <p className="text-sm text-muted-foreground">
              Target Device ID:{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{targetDeviceId}</code>
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
          signalUrl={signalUrl}
          error={webrtcError}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        {connectionState === 'connected' &&
          (connectionMode === 'relay' || dataChannelState === 'open') && (
            <>
              {/* View mode tabs */}
              <div className="flex gap-2 px-4">
                <Button
                  variant={viewMode === 'services' ? 'default' : 'outline'}
                  onClick={() => setViewMode('services')}
                >
                  Service Catalog
                </Button>
                <Button
                  variant={viewMode === 'clients' ? 'default' : 'outline'}
                  onClick={() => setViewMode('clients')}
                >
                  Legacy Clients
                </Button>
              </div>

              {/* View content */}
              {viewMode === 'services' ? (
                <ServicesCatalog
                  proxyFetch={proxyFetch}
                  onLaunchService={handleLaunchService}
                  launchBlockedReason={launchBlockedReason}
                />
              ) : (
                <ClientSelector proxyFetch={proxyFetch} onSelectClient={handleSelectClient} />
              )}

              <APITester proxyFetch={proxyFetch} isConnected={true} />
            </>
          )}
      </div>
    </div>
  )
}

export default App
