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
 * RunnersList component - displays runners with start/stop controls.
 */

import type { ReactElement } from 'react';
import { useRunners, useStartRunner, useStopRunner } from '../hooks/useRunners';
import { ApiError } from '../api/client';
import toast from 'react-hot-toast';
import type { Runner } from '../api/types';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';

type RunnerCardProps = {
  runner: Runner;
}

function RunnerCard({ runner }: RunnerCardProps): ReactElement {
  const startMutation = useStartRunner();
  const stopMutation = useStopRunner();

  const isRunning = runner.status === 'running';
  const isLoading = startMutation.isPending || stopMutation.isPending;

  const handleStart = async (): Promise<void> => {
    try {
      await startMutation.mutateAsync(runner.id);
      toast.success(`${runner.name} started successfully`);
    } catch (error) {
      if (error instanceof ApiError) {
        toast.error(`Failed to start ${runner.name}: ${error.message}`);
      } else {
        toast.error(`Failed to start ${runner.name}`);
      }
    }
  };

  const handleStop = async (): Promise<void> => {
    try {
      await stopMutation.mutateAsync(runner.id);
      toast.success(`${runner.name} stopped successfully`);
    } catch (error) {
      if (error instanceof ApiError) {
        toast.error(`Failed to stop ${runner.name}: ${error.message}`);
      } else {
        toast.error(`Failed to stop ${runner.name}`);
      }
    }
  };

  const getStatusVariant = (status: string): 'default' | 'success' | 'secondary' | 'destructive' => {
    switch (status) {
      case 'running':
        return 'success';
      case 'stopped':
        return 'secondary';
      case 'error':
        return 'destructive';
      default:
        return 'default';
    }
  };

  return (
    <Card className="transition-all hover:border-border/80 hover:shadow-lg overflow-hidden">
      <CardHeader className="bg-muted">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">{runner.name}</CardTitle>
          <Badge
            variant={getStatusVariant(runner.status)}
            className="uppercase"
          >
            {runner.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-5">
        <div className="flex justify-between text-sm">
          <span className="font-medium text-muted-foreground">Version:</span>
          <span className="text-foreground">{runner.version}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="font-medium text-muted-foreground">Endpoint:</span>
          <span className="text-foreground">{runner.endpoint}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="font-medium text-muted-foreground">
            Capabilities:
          </span>
          <span className="text-foreground">
            {runner.capabilities.join(", ")}
          </span>
        </div>
      </CardContent>
      <CardFooter className="gap-3">
        {isRunning ? (
          <Button
            variant="destructive"
            className="w-full"
            onClick={handleStop}
            disabled={isLoading}
          >
            {isLoading ? "Stopping..." : "Stop"}
          </Button>
        ) : (
          <Button className="w-full" onClick={handleStart} disabled={isLoading}>
            {isLoading ? "Starting..." : "Start"}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

export function RunnersList(): ReactElement {
  const { data: runners, isLoading, error } = useRunners();

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground">Loading runners...</p>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Failed to load runners: {error instanceof Error ? error.message : 'Unknown error'}
        </AlertDescription>
      </Alert>
    );
  }

  if (!runners || runners.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground">No runners available</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold">Runners</h2>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {runners.map((runner) => (
          <RunnerCard key={runner.id} runner={runner} />
        ))}
      </div>
    </div>
  );
}
