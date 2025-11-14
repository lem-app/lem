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
 * API tester component - demonstrates HTTP-over-DataChannel proxy.
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'

type APITesterProps = {
  proxyFetch: (url: string, init?: RequestInit) => Promise<Response>
  isConnected: boolean
}

export function APITester({ proxyFetch, isConnected }: APITesterProps): ReactElement {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const testHealthEndpoint = async () => {
    if (!isConnected) {
      setError('Not connected to local server')
      return
    }

    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const response = await proxyFetch('http://localhost:5142/v1/health')
      const data = await response.json()
      setResult(JSON.stringify(data, null, 2))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const testRunnersEndpoint = async () => {
    if (!isConnected) {
      setError('Not connected to local server')
      return
    }

    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const response = await proxyFetch('http://localhost:5142/v1/runners')
      const data = await response.json()
      setResult(JSON.stringify(data, null, 2))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const testClientsEndpoint = async () => {
    if (!isConnected) {
      setError('Not connected to local server')
      return
    }

    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const response = await proxyFetch('http://localhost:5142/v1/clients')
      const data = await response.json()
      setResult(JSON.stringify(data, null, 2))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-4">
      <Card>
        <CardHeader>
          <CardTitle>API Tester</CardTitle>
          <CardDescription>
            Test HTTP proxying over the WebRTC DataChannel. These requests are sent to your local
            Lem server at <code className="rounded bg-muted px-1 py-0.5 text-sm">http://localhost:5142</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <Button onClick={testHealthEndpoint} disabled={!isConnected || loading} size="sm">
              Test /v1/health
            </Button>
            <Button onClick={testRunnersEndpoint} disabled={!isConnected || loading} size="sm">
              Test /v1/runners
            </Button>
            <Button onClick={testClientsEndpoint} disabled={!isConnected || loading} size="sm">
              Test /v1/clients
            </Button>
          </div>

          {loading && (
            <div className="py-3 text-center text-sm text-primary">Loading...</div>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>
                <h3 className="mb-2 font-semibold">Error</h3>
                <pre className="overflow-x-auto text-xs">{error}</pre>
              </AlertDescription>
            </Alert>
          )}

          {result && (
            <Alert className="border-green-600 bg-green-950">
              <AlertDescription>
                <h3 className="mb-2 font-semibold text-green-400">Response</h3>
                <pre className="overflow-x-auto text-xs text-green-300">{result}</pre>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
