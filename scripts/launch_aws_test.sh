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
#
# This harness points at cloud signaling/relay; it does not need the API itself
# to be reachable from the network, so it binds loopback like every other launch
# path. It goes through lem-serve, so the posture is not taken on trust:
# lem-serve binds the socket, reads the address back from it, and derives the
# /v1/* auth decision from that. Watch the startup line - it states the verified
# address and the decision.
#
# Export LEM_HOST=0.0.0.0 if you really want the API on the LAN. Every /v1/*
# request then needs "Authorization: Bearer $(cat ~/.lem/api_token)", and the
# dashboard below will 401 on load - it has no way to obtain that token
# (see https://github.com/lem-app/lem/issues/48).
echo "→ Local Lem Server (port ${LEM_PORT:-5142})"
(cd ../server && LEM_SIGNAL_URL=https://signal.lem.gg \
    LEM_HOST="${LEM_HOST:-127.0.0.1}" LEM_PORT="${LEM_PORT:-5142}" uv run lem-serve) &
sleep 2

# Start local web dashboard with AWS signaling URL as default.
echo "→ Local Web Dashboard (port 5174)"
(cd ../web/local && VITE_DEFAULT_SIGNALING_URL=https://signal.lem.gg pnpm dev --port 5174) &
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
