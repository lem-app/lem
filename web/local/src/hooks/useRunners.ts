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

// Hook for polling runners data
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getRunners,
  startRunner,
  stopRunner,
  installRunner,
  type ApiError,
} from '../api/client';

const POLL_INTERVAL = 5000; // 5 seconds (api.md §0.1.1)

export function useRunners() {
  return useQuery({
    queryKey: ['runners'],
    queryFn: getRunners,
    refetchInterval: POLL_INTERVAL,
    refetchIntervalInBackground: true,
  });
}

export function useStartRunner() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (runnerId: string) => startRunner(runnerId),
    onSuccess: () => {
      // Immediately refetch to show updated status
      void queryClient.invalidateQueries({ queryKey: ['runners'] });
    },
    onError: (error: ApiError) => {
      throw error;
    },
  });
}

export function useStopRunner() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (runnerId: string) => stopRunner(runnerId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['runners'] });
    },
    onError: (error: ApiError) => {
      throw error;
    },
  });
}

export function useInstallRunner() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (runnerId: string) => installRunner(runnerId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['runners'] });
    },
    onError: (error: ApiError) => {
      throw error;
    },
  });
}
