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
 * Service card component for displaying a single service with actions.
 */

import { type ReactElement, useState } from 'react'
import type { Service, ServiceStatus, ServiceCategory, JobResponse } from '../api/types'
import { useJob } from '../hooks/useJob'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Loader2, Play, Square, Trash2, Download, ExternalLink } from 'lucide-react'

interface ServiceCardProps {
  service: Service
  proxyFetch: (url: string, init?: RequestInit) => Promise<Response>
  onInstall: (serviceId: string) => Promise<JobResponse>
  onStart: (serviceId: string) => Promise<void>
  onStop: (serviceId: string) => Promise<void>
  onRemove: (serviceId: string) => Promise<JobResponse>
  onLaunch?: (serviceId: string) => void
  isActionLoading: boolean
}

export function ServiceCard({
  service,
  proxyFetch,
  onInstall,
  onStart,
  onStop,
  onRemove,
  onLaunch,
  isActionLoading,
}: ServiceCardProps): ReactElement {
  const [activeJobId, setActiveJobId] = useState<string | null>(null)

  const { job } = useJob({
    proxyFetch,
    jobId: activeJobId,
    onComplete: () => setActiveJobId(null),
  })

  const isInstalled = service.status !== 'not_installed'
  const isRunning = service.status === 'running'
  const hasActiveJob = job && (job.status === 'pending' || job.status === 'running')
  const isDisabled = isActionLoading || !!hasActiveJob

  const handleInstall = async () => {
    try {
      const result = await onInstall(service.id)
      setActiveJobId(result.job_id)
    } catch (err) {
      console.error('Install failed:', err)
    }
  }

  const handleStart = async () => {
    try {
      await onStart(service.id)
    } catch (err) {
      console.error('Start failed:', err)
    }
  }

  const handleStop = async () => {
    try {
      await onStop(service.id)
    } catch (err) {
      console.error('Stop failed:', err)
    }
  }

  const handleRemove = async () => {
    try {
      const result = await onRemove(service.id)
      setActiveJobId(result.job_id)
    } catch (err) {
      console.error('Remove failed:', err)
    }
  }

  const getStatusVariant = (
    status: ServiceStatus
  ): 'default' | 'secondary' | 'destructive' | 'outline' => {
    switch (status) {
      case 'running':
        return 'default'
      case 'stopped':
        return 'secondary'
      case 'not_installed':
        return 'outline'
      case 'error':
        return 'destructive'
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
    }
  }

  const formatStatus = (status: ServiceStatus): string => {
    return status.replace('_', ' ')
  }

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
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

      <CardContent className="flex-1 space-y-3">
        <p className="line-clamp-2 text-sm text-muted-foreground">{service.description}</p>

        {service.depends_on.length > 0 && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">Requires:</span> {service.depends_on.join(', ')}
          </p>
        )}

        {/* Job progress */}
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
          <Button className="w-full" onClick={handleInstall} disabled={isDisabled}>
            {hasActiveJob ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Installing...
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                Install
              </>
            )}
          </Button>
        ) : isRunning ? (
          <>
            {service.has_ui && onLaunch && (
              <Button variant="default" className="flex-1" onClick={() => onLaunch(service.id)}>
                <ExternalLink className="mr-2 h-4 w-4" />
                Launch
              </Button>
            )}
            <Button
              variant="destructive"
              className="flex-1"
              onClick={handleStop}
              disabled={isDisabled}
            >
              <Square className="mr-2 h-4 w-4" />
              Stop
            </Button>
          </>
        ) : (
          <>
            <Button className="flex-1" onClick={handleStart} disabled={isDisabled}>
              <Play className="mr-2 h-4 w-4" />
              Start
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={handleRemove}
              disabled={isDisabled}
            >
              {hasActiveJob ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Remove
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  )
}
