#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2025 Lem
#
# Launch local server and web dashboard for testing against AWS infrastructure.
# Overrides VITE_DEFAULT_SIGNALING_URL to point at cloud services.
#
# For fully local development, use launch_servers.sh instead.

set -e

cleanup() {
    echo -e "\nShutting down..."
    kill 0
}
trap cleanup EXIT INT TERM

echo "Starting local services for AWS testing..."
echo ""

# Start Lem local server with AWS signaling URL override.
# This remote-test harness deliberately binds 0.0.0.0, unlike every other launch
# path (which defaults to 127.0.0.1). It goes through lem-serve like everything
# else, so the posture is not taken on trust: lem-serve binds the socket, reads
# 0.0.0.0 back from it, and enforces bearer-token auth on /v1/* accordingly.
# Watch the startup line - it states the verified address and the decision.
echo "→ Local Lem Server (port 5142)"
(cd ../server && LEM_SIGNAL_URL=https://signal.lem.gg LEM_HOST=0.0.0.0 LEM_PORT=5142 uv run lem-serve) &
sleep 2

# Start local web dashboard with AWS signaling URL as default.
# The server is network-bound, so the dashboard must present the API token and
# its own origin has to be allowlisted server-side via LEM_ALLOWED_ORIGINS.
echo "→ Local Web Dashboard (port 5174)"
(cd ../web/local && VITE_DEFAULT_SIGNALING_URL=https://signal.lem.gg \
    VITE_LEM_API_TOKEN="$(cat ~/.lem/api_token 2>/dev/null)" pnpm dev --port 5174) &
sleep 3

echo ""
echo "✓ Local services running"
echo ""
echo "AWS Signaling: https://signal.lem.gg"
echo "AWS Relay:     https://relay.lem.gg"
echo ""
echo "Local Server:  http://localhost:5142 (LEM_SIGNAL_URL=https://signal.lem.gg)"
echo "Local Web:     http://localhost:5174 (VITE_DEFAULT_SIGNALING_URL=https://signal.lem.gg)"
echo ""
echo "→ Open http://localhost:5174 and login with your AWS credentials"
echo ""

wait
