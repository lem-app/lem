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

// Hook for polling tunnel status
import { useQuery } from '@tanstack/react-query';
import { getTunnelStatus } from '../api/client';

const POLL_INTERVAL = 5000; // 5 seconds (api.md §0.1.1)

export function useTunnelStatus() {
  return useQuery({
    queryKey: ['tunnel', 'status'],
    queryFn: getTunnelStatus,
    refetchInterval: POLL_INTERVAL,
    refetchIntervalInBackground: true,
    // Tunnel status might not be implemented yet (returns 501)
    // Don't throw on error, just return undefined
    retry: false,
  });
}
