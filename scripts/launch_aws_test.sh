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

# Start Lem local server
echo "→ Local Lem Server (port 5142)"
(cd ../server && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 5142) &
sleep 2

# Start local web dashboard with AWS signaling URL as default
echo "→ Local Web Dashboard (port 5174)"
(cd ../web/local && VITE_DEFAULT_SIGNALING_URL=https://signal.lem.gg pnpm dev --port 5174) &
sleep 3

echo ""
echo "✓ Local services running"
echo ""
echo "AWS Signaling: https://signal.lem.gg"
echo "AWS Relay:     https://relay.lem.gg"
echo ""
echo "Local Server:  http://localhost:5142"
echo "Local Web:     http://localhost:5174"
echo ""
echo "→ Open http://localhost:5174 and login with your AWS credentials"
echo "  The signaling URL will default to https://signal.lem.gg"
echo ""

wait
