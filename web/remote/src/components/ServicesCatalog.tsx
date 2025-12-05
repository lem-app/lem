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
 * Service catalog component for managing Harbor services remotely.
 */

import { type ReactElement, useState } from 'react'
import type { ServiceCategory, ServiceStatus } from '../api/types'
import { useServices } from '../hooks/useServices'
import { useServiceActions } from '../hooks/useServiceActions'
import { ServiceCard } from './ServiceCard'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, Search, AlertCircle } from 'lucide-react'

type FilterOption = 'all' | ServiceCategory | 'installed'

interface ServicesCatalogProps {
  proxyFetch: (url: string, init?: RequestInit) => Promise<Response>
  onLaunchService: (serviceId: string) => void
}

export function ServicesCatalog({
  proxyFetch,
  onLaunchService,
}: ServicesCatalogProps): ReactElement {
  const [filter, setFilter] = useState<FilterOption>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const { services, isLoading, error, refetch } = useServices({ proxyFetch })
  const actions = useServiceActions({ proxyFetch, onSuccess: refetch })

  if (isLoading && services.length === 0) {
    return (
      <div className="p-4">
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Loading services from local server...</p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>Failed to load services: {error.message}</AlertDescription>
      </Alert>
    )
  }

  // Filter services
  let filteredServices = services

  if (filter === 'installed') {
    filteredServices = filteredServices.filter((s) => s.status !== 'not_installed')
  } else if (filter !== 'all') {
    filteredServices = filteredServices.filter((s) => s.category === filter)
  }

  if (searchQuery) {
    const query = searchQuery.toLowerCase()
    filteredServices = filteredServices.filter(
      (s) =>
        s.name.toLowerCase().includes(query) ||
        s.description.toLowerCase().includes(query) ||
        s.id.toLowerCase().includes(query)
    )
  }

  // Sort: running > stopped > not_installed
  const statusOrder: Record<ServiceStatus, number> = {
    running: 0,
    stopped: 1,
    error: 2,
    not_installed: 3,
  }
  filteredServices = [...filteredServices].sort(
    (a, b) => statusOrder[a.status] - statusOrder[b.status]
  )

  const installedCount = services.filter((s) => s.status !== 'not_installed').length

  return (
    <div className="space-y-6 p-4">
      {/* Header with filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-2xl font-semibold">
          Service Catalog
          <span className="ml-2 text-lg font-normal text-muted-foreground">
            ({installedCount} installed)
          </span>
        </h2>

        <div className="flex flex-wrap gap-2">
          {/* Search input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search services..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="rounded-md border border-input bg-background py-1 pl-9 pr-3 text-sm"
            />
          </div>

          {/* Filter buttons */}
          <Button
            variant={filter === 'all' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter('all')}
          >
            All ({services.length})
          </Button>
          <Button
            variant={filter === 'installed' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter('installed')}
          >
            Installed ({installedCount})
          </Button>
          <Button
            variant={filter === 'backend' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter('backend')}
          >
            Backend
          </Button>
          <Button
            variant={filter === 'frontend' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter('frontend')}
          >
            Frontend
          </Button>
          <Button
            variant={filter === 'satellite' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter('satellite')}
          >
            Satellite
          </Button>
        </div>
      </div>

      {/* Service grid */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {filteredServices.map((service) => (
          <ServiceCard
            key={service.id}
            service={service}
            proxyFetch={proxyFetch}
            onInstall={actions.installService}
            onStart={async (id) => {
              await actions.startService(id)
            }}
            onStop={async (id) => {
              await actions.stopService(id)
            }}
            onRemove={actions.removeService}
            onLaunch={service.has_ui ? onLaunchService : undefined}
            isActionLoading={actions.isLoading}
          />
        ))}
      </div>

      {filteredServices.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No services match your filters
          </CardContent>
        </Card>
      )}
    </div>
  )
}
