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

// Hook for model operations
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getRunnerModels, pullModel, type ApiError } from '../api/client';

const POLL_INTERVAL = 5000; // 5 seconds (api.md §0.1.1)

export function useRunnerModels(runnerId: string) {
  return useQuery({
    queryKey: ['runners', runnerId, 'models'],
    queryFn: () => getRunnerModels(runnerId),
    refetchInterval: POLL_INTERVAL,
    refetchIntervalInBackground: true,
    enabled: !!runnerId, // Only fetch if runnerId is provided
  });
}

export function usePullModel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      runnerId,
      modelRef,
    }: {
      runnerId: string;
      modelRef: string;
    }) => pullModel(runnerId, { model_ref: modelRef }),
    onSuccess: (_, variables) => {
      // Invalidate models query to show pulling status
      void queryClient.invalidateQueries({
        queryKey: ['runners', variables.runnerId, 'models'],
      });
    },
    onError: (error: ApiError) => {
      throw error;
    },
  });
}
