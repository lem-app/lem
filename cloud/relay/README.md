# Lem Relay Server

WebSocket-based relay server for fallback connectivity when P2P WebRTC and TURN both fail.

## Overview

The relay server provides a simple frame-forwarding service:
- Two clients connect to the same session ID
- Frames from one client are forwarded to the other bidirectionally
- JWT authentication required
- Session statistics logged for metering

## Setup

```bash
# Install dependencies
cd cloud/relay
uv sync

# Run server
uv run uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
```

## API

### Health Check

```bash
curl http://localhost:8001/health
```

### WebSocket Relay

Connect to: `ws://localhost:8001/relay/{session_id}?token={jwt_token}`

Both clients must:
1. Use the same `session_id`
2. Provide a valid JWT token (from signaling server)
3. Connect within session timeout window

## Testing with wscat

```bash
# Install wscat if needed
npm install -g wscat

# Get a token from signaling server first
TOKEN="your-jwt-token-here"

# Terminal 1 (client 1)
wscat -c "ws://localhost:8001/relay/test-session-123?token=$TOKEN"

# Terminal 2 (client 2)
wscat -c "ws://localhost:8001/relay/test-session-123?token=$TOKEN"

# Type messages in either terminal - they should appear in the other
```

## Architecture

```
┌─────────┐                  ┌─────────────┐                  ┌─────────┐
│ Client  │◄────WebSocket────►│   Relay     │◄────WebSocket────►│ Server  │
│ (WS 1)  │                  │   Session   │                  │ (WS 2)  │
└─────────┘                  └─────────────┘                  └─────────┘
                                    │
                                    ▼
                             Frame Forwarding
                           (binary, bidirectional)
```

## Security

- **v0.1**: TLS only, relay sees plaintext
- **v1.0**: Add Noise XX encryption (end-to-end)

## Session Lifecycle

1. First client connects → session created, waiting for peer
2. Second client connects → both connected, start forwarding
3. Either disconnects → close both, log stats

## Logging

Session stats are logged as JSON to stdout for future metering:

```json
{
  "event": "session_closed",
  "session_id": "test-session-123",
  "duration_seconds": 45.2,
  "bytes_client_to_server": 12345,
  "bytes_server_to_client": 54321,
  "total_bytes": 66666,
  "timestamp": "2025-11-11T12:34:56.789Z"
}
```

## Configuration

See `app/core/config.py` for settings:
- `SECRET_KEY`: JWT secret (must match signaling server)
- `PORT`: Server port (default: 8001)
- `SESSION_TIMEOUT`: Idle timeout (default: 300s)
