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
 * ServicesList component - displays Harbor services from the catalog.
 */

import { useEffect, useState, type ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useServices,
  useInstallService,
  useStartService,
  useStopService,
  useRemoveService,
} from '../hooks/useServices'
import { useJob } from '../hooks/useJobs'
import { ApiError } from '../api/client'
import { safeExternalHref } from '@/lib/utils'
import toast from 'react-hot-toast'
import type { Service, ServiceCategory, ServiceStatus, JobResponse } from '../api/types'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'

type ServiceCardProps = {
  service: Service
}

function ServiceCard({ service }: ServiceCardProps): ReactElement {
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const installMutation = useInstallService()
  const startMutation = useStartService()
  const stopMutation = useStopService()
  const removeMutation = useRemoveService()

  // Track job progress
  const { data: job } = useJob(activeJobId)

  const isInstalled = service.status !== 'not_installed'
  const isRunning = service.status === 'running'
  const isLoading =
    installMutation.isPending ||
    startMutation.isPending ||
    stopMutation.isPending ||
    removeMutation.isPending
  const hasActiveJob = job && (job.status === 'pending' || job.status === 'running')
  const endpointHref = safeExternalHref(service.endpoint)

  // Clear the job once it finishes, and refresh the catalog.
  //
  // This used to call setActiveJobId(null) *during render*, which React warns
  // about and which is the wrong place for a side effect. Nothing invalidated
  // ["services"] either, so a freshly installed service kept reading
  // "not installed" until the next 5s poll happened to land.
  useEffect(() => {
    if (!activeJobId || !job) return
    if (job.status !== 'completed' && job.status !== 'failed') return

    setActiveJobId(null)
    void queryClient.invalidateQueries({ queryKey: ['services'] })
  }, [activeJobId, job, queryClient])

  /**
   * Start tracking a new job.
   *
   * Drops any cached entry for this job id first: React Query would otherwise
   * hand back a *completed* job from cache, `hasActiveJob` would be false from
   * the first render, and the progress bar would never appear.
   */
  const trackJob = (jobId: string): void => {
    queryClient.removeQueries({ queryKey: ['job', jobId] })
    setActiveJobId(jobId)
  }

  const handleInstall = async (): Promise<void> => {
    try {
      const response: JobResponse = await installMutation.mutateAsync(service.id)
      trackJob(response.job_id)
      toast.success(`Installing ${service.name}...`)
    } catch (error) {
      if (error instanceof ApiError) {
        toast.error(`Failed to install ${service.name}: ${error.message}`)
      } else {
        toast.error(`Failed to install ${service.name}`)
      }
    }
  }

  const handleStart = async (): Promise<void> => {
    try {
      await startMutation.mutateAsync(service.id)
      toast.success(`${service.name} started successfully`)
    } catch (error) {
      if (error instanceof ApiError) {
        toast.error(`Failed to start ${service.name}: ${error.message}`)
      } else {
        toast.error(`Failed to start ${service.name}`)
      }
    }
  }

  const handleStop = async (): Promise<void> => {
    try {
      await stopMutation.mutateAsync(service.id)
      toast.success(`${service.name} stopped successfully`)
    } catch (error) {
      if (error instanceof ApiError) {
        toast.error(`Failed to stop ${service.name}: ${error.message}`)
      } else {
        toast.error(`Failed to stop ${service.name}`)
      }
    }
  }

  const handleRemove = async (): Promise<void> => {
    try {
      const response: JobResponse = await removeMutation.mutateAsync(service.id)
      trackJob(response.job_id)
      toast.success(`Removing ${service.name}...`)
    } catch (error) {
      if (error instanceof ApiError) {
        toast.error(`Failed to remove ${service.name}: ${error.message}`)
      } else {
        toast.error(`Failed to remove ${service.name}`)
      }
    }
  }

  const getStatusVariant = (
    status: ServiceStatus
  ): 'default' | 'success' | 'secondary' | 'destructive' | 'outline' => {
    switch (status) {
      case 'running':
        return 'success'
      case 'stopped':
        return 'secondary'
      case 'not_installed':
        return 'outline'
      case 'error':
        return 'destructive'
      default:
        return 'default'
    }
  }

  const getCategoryVariant = (category: ServiceCategory): 'default' | 'secondary' | 'outline' => {
    switch (category) {
      case 'backend':
        return 'default'
      case 'frontend':
        return 'secondary'
      case 'satellite':
        return 'outline'
      default:
        return 'default'
    }
  }

  const formatStatus = (status: ServiceStatus): string => {
    return status.replace('_', ' ')
  }

  return (
    <Card className="flex flex-col overflow-hidden transition-all hover:border-border/80 hover:shadow-lg">
      <CardHeader className="bg-muted">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="truncate text-lg">{service.name}</CardTitle>
          <div className="flex shrink-0 gap-1">
            <Badge variant={getCategoryVariant(service.category)} className="text-xs">
              {service.category}
            </Badge>
            <Badge variant={getStatusVariant(service.status)} className="text-xs uppercase">
              {formatStatus(service.status)}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 space-y-3 pt-5">
        <p className="line-clamp-2 text-sm text-muted-foreground">{service.description}</p>
        {service.endpoint && (
          <div className="flex justify-between text-sm">
            <span className="font-medium text-muted-foreground">Endpoint:</span>
            {/* Server-supplied URL: only linked when it is http(s). */}
            {endpointHref ? (
              <a
                href={endpointHref}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {service.endpoint}
              </a>
            ) : (
              <span className="text-muted-foreground">{service.endpoint}</span>
            )}
          </div>
        )}
        {service.depends_on.length > 0 && (
          <div className="text-sm">
            <span className="font-medium text-muted-foreground">Requires: </span>
            <span className="text-foreground">{service.depends_on.join(', ')}</span>
          </div>
        )}
        {hasActiveJob && job && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{job.message}</span>
              <span className="font-medium">{job.progress}%</span>
            </div>
            <Progress value={job.progress} className="h-2" />
          </div>
        )}
      </CardContent>
      <CardFooter className="gap-2">
        {!isInstalled ? (
          <Button
            className="w-full"
            onClick={() => void handleInstall()}
            disabled={isLoading || hasActiveJob}
          >
            {hasActiveJob ? 'Installing...' : 'Install'}
          </Button>
        ) : isRunning ? (
          <>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={() => void handleStop()}
              disabled={isLoading || hasActiveJob}
            >
              {stopMutation.isPending ? 'Stopping...' : 'Stop'}
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => void handleRemove()}
              disabled={isLoading || hasActiveJob}
            >
              Remove
            </Button>
          </>
        ) : (
          <>
            <Button
              className="flex-1"
              onClick={() => void handleStart()}
              disabled={isLoading || hasActiveJob}
            >
              {startMutation.isPending ? 'Starting...' : 'Start'}
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => void handleRemove()}
              disabled={isLoading || hasActiveJob}
            >
              {hasActiveJob ? 'Removing...' : 'Remove'}
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  )
}

type FilterOption = 'all' | ServiceCategory | 'installed'

export function ServicesList(): ReactElement {
  const [filter, setFilter] = useState<FilterOption>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const { data: services, isLoading, error } = useServices()

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground">Loading services...</p>
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Failed to load services: {error instanceof Error ? error.message : 'Unknown error'}
        </AlertDescription>
      </Alert>
    )
  }

  if (!services || services.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground">No services available</p>
      </div>
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

  // Sort: running first, then stopped, then not installed
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
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-2xl font-semibold">
          Services{' '}
          <span className="text-lg font-normal text-muted-foreground">
            ({installedCount} installed)
          </span>
        </h2>
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            placeholder="Search services..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-1 text-sm"
          />
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
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {filteredServices.map((service) => (
          <ServiceCard key={service.id} service={service} />
        ))}
      </div>
      {filteredServices.length === 0 && (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <p className="text-muted-foreground">No services match your filters</p>
        </div>
      )}
    </div>
  )
}
