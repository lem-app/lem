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

// Hook for polling clients data
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getClients,
  startClient,
  stopClient,
  installClient,
  type ApiError,
} from '../api/client';

const POLL_INTERVAL = 5000; // 5 seconds (api.md §0.1.1)

export function useClients() {
  return useQuery({
    queryKey: ['clients'],
    queryFn: getClients,
    refetchInterval: POLL_INTERVAL,
    refetchIntervalInBackground: true,
  });
}

export function useStartClient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (clientId: string) => startClient(clientId),
    onSuccess: () => {
      // Immediately refetch to show updated status
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
    onError: (error: ApiError) => {
      throw error;
    },
  });
}

export function useStopClient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (clientId: string) => stopClient(clientId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
    onError: (error: ApiError) => {
      throw error;
    },
  });
}

export function useInstallClient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (clientId: string) => installClient(clientId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
    onError: (error: ApiError) => {
      throw error;
    },
  });
}
