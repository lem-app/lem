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

// Hook for services data and operations
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getServices,
  installService,
  startService,
  stopService,
  removeService,
} from '../api/client'

const POLL_INTERVAL = 5000 // 5 seconds

export function useServices() {
  return useQuery({
    queryKey: ['services'],
    queryFn: getServices,
    refetchInterval: POLL_INTERVAL,
    refetchIntervalInBackground: true,
  })
}

export function useInstallService() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (serviceId: string) => installService(serviceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['services'] })
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
  })
}

export function useStartService() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (serviceId: string) => startService(serviceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['services'] })
    },
  })
}

export function useStopService() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (serviceId: string) => stopService(serviceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['services'] })
    },
  })
}

export function useRemoveService() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (serviceId: string) => removeService(serviceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['services'] })
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
  })
}
