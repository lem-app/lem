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

// Hook for job tracking
import { useQuery } from "@tanstack/react-query";
import { getJobs, getJob } from "../api/client";

// Poll faster during active jobs
const FAST_POLL_INTERVAL = 1000; // 1 second
const SLOW_POLL_INTERVAL = 10000; // 10 seconds

export function useJobs(serviceId?: string) {
  return useQuery({
    queryKey: ["jobs", serviceId],
    queryFn: () => getJobs(serviceId),
    refetchInterval: SLOW_POLL_INTERVAL,
    refetchIntervalInBackground: false,
  });
}

export function useJob(jobId: string | null) {
  return useQuery({
    queryKey: ["job", jobId],
    queryFn: () => (jobId ? getJob(jobId) : Promise.reject("No job ID")),
    enabled: !!jobId,
    refetchInterval: (query) => {
      // Poll faster while job is running
      const job = query.state.data;
      if (job && (job.status === "pending" || job.status === "running")) {
        return FAST_POLL_INTERVAL;
      }
      return false; // Stop polling when job is complete
    },
  });
}

export function useActiveJobs() {
  const { data: jobs } = useJobs();

  // Filter to only active (pending/running) jobs
  const activeJobs = jobs?.filter(
    (job) => job.status === "pending" || job.status === "running",
  );

  return {
    activeJobs: activeJobs ?? [],
    hasActiveJobs: (activeJobs?.length ?? 0) > 0,
  };
}
