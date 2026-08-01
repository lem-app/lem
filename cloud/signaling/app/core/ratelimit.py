# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2025 Lem
#
# This file is part of Lem.
#
# Lem is free software: you can redistribute it and/or modify it under
# the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# Lem is distributed in the hope that it will be useful, but WITHOUT
# ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
# or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General
# Public License for more details.

"""In-process rate limiting for unauthenticated and cheap-to-abuse endpoints.

Registration and login were previously unauthenticated *and* unthrottled, so
an attacker could mint unlimited accounts (each of which was enough to reach
the tunnel endpoints) and brute-force passwords.

This is a sliding-window counter held in this process. It is deliberately not
Redis-backed: the servers already have to run with a single worker because the
connection registry and relay sessions are in-process too, so a shared store
would buy nothing yet. nginx ``limit_req`` in deploy/ provides the coarse
edge-level limit; this provides the per-account one nginx cannot see.
"""

import time
from collections import deque

from fastapi import Request

from .config import settings


class RateLimiter:
    """Sliding-window rate limiter keyed by an arbitrary string."""

    def __init__(self, limit: int, window_seconds: float) -> None:
        """Initialize the limiter.

        Args:
            limit: Maximum number of allowed events per window.
            window_seconds: Length of the sliding window in seconds.
        """
        self.limit = limit
        self.window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = {}

    def check(self, key: str) -> bool:
        """Record an event for a key and report whether it is within the limit.

        Args:
            key: Bucket identifier, e.g. a client IP or an email address.

        Returns:
            True if the event is allowed, False if the limit is exceeded.
        """
        now = time.monotonic()
        cutoff = now - self.window_seconds

        hits = self._hits.get(key)
        if hits is None:
            hits = deque()
            self._hits[key] = hits

        while hits and hits[0] < cutoff:
            hits.popleft()

        if len(hits) >= self.limit:
            # Do not record rejected attempts: a caller that keeps hammering
            # should not be able to extend its own penalty window forever, and
            # not recording keeps the deque bounded by `limit`.
            return False

        hits.append(now)
        self._purge_idle(cutoff)
        return True

    def reset(self) -> None:
        """Forget all recorded events. Used by tests."""
        self._hits.clear()

    def _purge_idle(self, cutoff: float) -> None:
        """Drop buckets whose events have all aged out.

        Args:
            cutoff: Timestamp before which events no longer count.
        """
        # Bounded scan: buckets are cheap and this keeps memory from growing
        # without limit under a spray of distinct source addresses.
        idle = [key for key, hits in self._hits.items() if not hits or hits[-1] < cutoff]
        for key in idle:
            del self._hits[key]


def client_ip(request_or_scope_client: Request) -> str:
    """Determine the client address to rate limit on.

    Args:
        request_or_scope_client: The incoming HTTP request.

    Returns:
        Client IP address, or "unknown" if it cannot be determined.
    """
    if settings.trust_x_forwarded_for:
        forwarded = request_or_scope_client.headers.get("x-forwarded-for")
        if forwarded:
            # The shipped nginx configs use $proxy_add_x_forwarded_for, which
            # appends the real peer address to whatever the client sent, so the
            # last element is the only one the proxy vouches for.
            return forwarded.split(",")[-1].strip()

    client = request_or_scope_client.client
    return client.host if client is not None else "unknown"


# Shared limiters. Module-level so all requests share the same counters.
register_limiter = RateLimiter(settings.max_registrations_per_hour, 3600.0)
login_ip_limiter = RateLimiter(settings.max_logins_per_minute, 60.0)
login_account_limiter = RateLimiter(settings.max_logins_per_minute, 60.0)
signal_connect_limiter = RateLimiter(settings.max_connections_per_second, 1.0)
