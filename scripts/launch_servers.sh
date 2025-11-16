#!/bin/bash
# Launch all Lem services for testing

set -e

cleanup() {
    echo -e "\nShutting down..."
    kill 0
}
trap cleanup EXIT INT TERM

echo "Starting services..."
echo ""

# # Start signaling server
# echo "→ Signaling Server (port 8000)"
# (cd cloud/signaling && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000) &
# sleep 2

# # Start relay server
# echo "→ Relay Server (port 8001)"
# (cd cloud/relay && uv run uvicorn app.main:app --host 0.0.0.0 --port 8001) &
# sleep 2

# # Start Lem server
# echo "→ Local Lem Server (port 5142)"
# (cd server && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 5142) &
# sleep 2

# Start browser remote app
echo "→ Browser Remote App (port 5173)"
(cd web/remote && pnpm dev) &
sleep 3

# Start browser local app
echo "→ Browser Local App (port 5174)"
(cd web/local && pnpm dev --port 5174) &
sleep 3

echo ""
echo "✓ All services running"
echo ""
echo "Signaling:  http://localhost:8000 (WebRTC signaling)"
echo "Relay:      http://localhost:8001 (WebSocket relay fallback)"
echo "Local App:  http://localhost:5174 (direct HTTP access)"
echo "Remote App: http://localhost:5173 (WebRTC/Relay remote access)"
echo ""
echo "      Login at http://localhost:5174 to enable remote access"
echo "      Remote app will use WebRTC P2P, fallback to relay if needed"
echo ""

wait
