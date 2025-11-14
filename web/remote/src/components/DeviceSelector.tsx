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
 * Device selector component for choosing target device.
 */

import { useState, useEffect } from 'react'
import type { ReactElement } from 'react'
import { listDevices } from '../api/auth'
import type { Device } from '../api/types'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

type DeviceSelectorProps = {
  onSelectDevice: (deviceId: string) => void
  token: string
}

export function DeviceSelector({ onSelectDevice, token }: DeviceSelectorProps): ReactElement {
  const [devices, setDevices] = useState<Device[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [manualEntry, setManualEntry] = useState(false)
  const [manualDeviceId, setManualDeviceId] = useState('')

  useEffect(() => {
    async function fetchDevices() {
      try {
        setIsLoading(true)
        setError(null)
        const deviceList = await listDevices(token)
        // Filter out browser devices (only show local server devices)
        const serverDevices = deviceList.filter((d) => !d.id.startsWith('browser-'))
        setDevices(serverDevices)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load devices')
      } finally {
        setIsLoading(false)
      }
    }

    fetchDevices()
  }, [token])

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (manualDeviceId.trim()) {
      onSelectDevice(manualDeviceId.trim())
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-2xl">
          <CardHeader>
            <CardTitle>Select Target Device</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">Loading devices...</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-2xl">
          <CardHeader>
            <CardTitle>Select Target Device</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
            <Button onClick={() => setManualEntry(true)} variant="secondary">
              Enter Device ID Manually
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (manualEntry) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-2xl">
          <CardHeader>
            <CardTitle>Enter Device ID</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleManualSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="deviceId">Target Device ID</Label>
                <Input
                  id="deviceId"
                  type="text"
                  value={manualDeviceId}
                  onChange={(e) => setManualDeviceId(e.target.value)}
                  placeholder="e.g., local-server-test-1"
                  required
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit">Connect</Button>
                <Button
                  type="button"
                  onClick={() => setManualEntry(false)}
                  variant="secondary"
                >
                  Back to List
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>Select Target Device</CardTitle>
          <CardDescription>Choose a device to connect to</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {devices.length === 0 ? (
            <div className="space-y-4">
              <p className="text-muted-foreground">
                No devices found. Make sure your local Lem server is registered.
              </p>
              <Button onClick={() => setManualEntry(true)} variant="secondary">
                Enter Device ID Manually
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                {devices.map((device) => (
                  <Card
                    key={device.id}
                    className="cursor-pointer transition-colors hover:bg-accent"
                    onClick={() => onSelectDevice(device.id)}
                  >
                    <CardContent className="p-4">
                      <div className="font-semibold">{device.id}</div>
                      <div className="text-sm text-muted-foreground">
                        Registered: {new Date(device.created_at).toLocaleString()}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
              <Button onClick={() => setManualEntry(true)} variant="secondary" className="w-full">
                Or Enter Device ID Manually
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
