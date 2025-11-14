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
 * ModelPull component - pull models for a runner.
 */

import type { ReactElement } from 'react';
import { useState } from 'react';
import { useRunnerModels, usePullModel } from '../hooks/useModels';
import { ApiError } from '../api/client';
import toast from 'react-hot-toast';
import type { Model } from '../api/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

type ModelPullProps = {
  runnerId: string;
  runnerName: string;
}

type ModelItemProps = {
  model: Model;
}

function ModelItem({ model }: ModelItemProps): ReactElement {
  const getStatusVariant = (status: string): 'default' | 'success' | 'secondary' | 'destructive' => {
    switch (status) {
      case 'ready':
        return 'success';
      case 'pulling':
        return 'default';
      case 'error':
        return 'destructive';
      default:
        return 'secondary';
    }
  };

  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-muted p-4 transition-all hover:border-border/80">
      <div className="flex items-center gap-3">
        <span className="font-semibold text-foreground">{model.name}</span>
        {model.tag && <span className="text-sm text-muted-foreground">{model.tag}</span>}
      </div>
      <Badge variant={getStatusVariant(model.status)} className="uppercase">
        {model.status}
      </Badge>
    </div>
  );
}

export function ModelPull({ runnerId, runnerName }: ModelPullProps): ReactElement {
  const [modelRef, setModelRef] = useState('');
  const { data: models, isLoading } = useRunnerModels(runnerId);
  const pullMutation = usePullModel();

  const handlePull = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();

    if (!modelRef.trim()) {
      toast.error('Please enter a model reference');
      return;
    }

    try {
      await pullMutation.mutateAsync({ runnerId, modelRef: modelRef.trim() });
      toast.success(`Pulling model: ${modelRef}`);
      setModelRef(''); // Clear input on success
    } catch (error) {
      if (error instanceof ApiError) {
        toast.error(`Failed to pull model: ${error.message}`);
      } else {
        toast.error('Failed to pull model');
      }
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Models for {runnerName}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <form onSubmit={handlePull} className="flex gap-3">
          <Input
            type="text"
            value={modelRef}
            onChange={(e) => setModelRef(e.target.value)}
            placeholder="Enter model ref (e.g., llama3:8b-q4)"
            disabled={pullMutation.isPending}
            className="flex-1"
          />
          <Button
            type="submit"
            disabled={pullMutation.isPending || !modelRef.trim()}
            className="min-w-32"
          >
            {pullMutation.isPending ? 'Pulling...' : 'Pull Model'}
          </Button>
        </form>

        <Separator />

        <div className="space-y-4">
          <h4 className="text-base font-medium">Installed Models</h4>
          {isLoading ? (
            <div className="rounded-lg border border-border bg-card p-8 text-center">
              <p className="text-muted-foreground">Loading models...</p>
            </div>
          ) : models && models.length > 0 ? (
            <div className="space-y-3">
              {models.map((model) => (
                <ModelItem key={model.id} model={model} />
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-card p-8 text-center">
              <p className="text-muted-foreground">No models installed yet</p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
