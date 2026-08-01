#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2025 Lem
#
# Launch all Lem services for LOCAL development testing.
# All apps use hardcoded localhost defaults - no env vars needed.
#
# For AWS/cloud testing, use launch_aws_test.sh instead.

set -e

cleanup() {
    echo -e "\nShutting down..."
    kill 0
}
trap cleanup EXIT INT TERM

echo "Starting local development services..."
echo ""

# Start signaling server
echo "→ Signaling Server (port 8000)"
(cd ../cloud/signaling && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000) &
sleep 2

# Start relay server
echo "→ Relay Server (port 8001)"
(cd ../cloud/relay && uv run uvicorn app.main:app --host 0.0.0.0 --port 8001) &
sleep 2

# Start Lem local server
# Binds to loopback by default: this API controls Docker on your machine.
# Export LEM_HOST=0.0.0.0 to expose it on the LAN (then every /v1/* request
# needs "Authorization: Bearer $(cat ~/.lem/api_token)").
echo "→ Local Lem Server (port 5142)"
(cd ../server && LEM_HOST="${LEM_HOST:-127.0.0.1}" uv run uvicorn app.main:app --reload --host "${LEM_HOST:-127.0.0.1}" --port 5142) &
sleep 2

# Start browser remote app
echo "→ Browser Remote App (port 5173)"
(cd ../web/remote && pnpm dev) &
sleep 3

# Start browser local app
echo "→ Browser Local App (port 5174)"
(cd ../web/local && pnpm dev --port 5174) &
sleep 3

echo ""
echo "✓ All services running"
echo ""
echo "Signaling:  http://localhost:8000 (WebRTC signaling)"
echo "Relay:      http://localhost:8001 (WebSocket relay fallback)"
echo "Local Lem:  http://localhost:5142 (local server API)"
echo ""
echo "Local App:  http://localhost:5174 (control local Lem server)"
echo "Remote App: http://localhost:5173 (connect via WebRTC/Relay)"
echo ""
echo "→ Login at http://localhost:5174 to register and enable remote access"
echo "→ Then use http://localhost:5173 to connect remotely"
echo ""

wait
