# Lem Relay Server

WebSocket-based relay server for fallback connectivity when P2P WebRTC and TURN both fail.

## Overview

The relay server provides a simple frame-forwarding service:
- Two devices of the **same account** connect to a session id minted by the
  signaling server
- Each presents a **session grant**: a short-lived signed token naming the
  session, the bearer device, its one permitted peer, and their owner
- Frames from one device are forwarded to the other bidirectionally
- Session statistics logged for metering (accounting only; no quota is
  enforced yet)

## Setup

```bash
# Install dependencies
cd cloud/relay
uv sync

# Configure. SECRET_KEY and CORS_ORIGINS are mandatory and have no defaults;
# the server refuses to start without them. The key must be identical to the
# signaling server's, because signaling mints the grants this server verifies.
cp .env.example .env
printf 'SECRET_KEY=%s\n' "$(openssl rand -hex 32)" >> .env

# Run server (single worker: sessions are in-process)
uv run uvicorn app.main:app --host 0.0.0.0 --port 8001 --workers 1 --reload

# Run tests
uv run pytest
```

## API

### Health Check

```bash
curl http://localhost:8001/health
```

### WebSocket Relay

Connect to: `ws://localhost:8001/relay/{session_id}`

Authenticate with either:
- a `?token={grant}` query parameter (deprecated: grants end up in logs), or
- a first text frame `{"type": "auth", "token": "{grant}"}`

The `{grant}` is **not an account access token**. It is the `relay_token` the
signaling server returned in `connect-request-sent` (to the requester) or
`connect-request-received` (to the target). An ordinary login token is
rejected. The grant carries:

| Claim | Meaning |
| --- | --- |
| `scope` | Always `relay-session`. Distinguishes a grant from a login token. |
| `sid` | The only session id this grant may be used on. Must equal the path segment. |
| `device_id` | The device permitted to present this grant. |
| `peer_device_id` | The only device permitted on the other side. |
| `user_id` | The account owning both devices. |
| `jti` | Unique id; a grant is redeemable once per session. |
| `exp` | Required. Short-lived (120s by default). |

The relay enforces that both connections in a session carry the same
`user_id` and the same `{device_id, peer_device_id}` pair, that no device
occupies both slots, and that a third connection is refused outright.

Both sides must connect within `PAIR_TIMEOUT` (30s by default); the first to
arrive buffers up to `MAX_PREPAIR_BUFFER_BYTES` while it waits and is
disconnected if its peer never shows. A paired session that relays nothing for
`SESSION_TIMEOUT` is closed.

## Testing with wscat

Each side needs its **own** grant, and the session id must be the one the
signaling server minted. Drive a `connect-request` through the signaling
server between two devices of one account, then use the `relay_session_id`
and the two `relay_token` values it returns.

```bash
# Install wscat if needed
npm install -g wscat

SESSION="<relay_session_id from the signaling server>"
GRANT_A="<relay_token from connect-request-sent>"
GRANT_B="<relay_token from connect-request-received>"

# Terminal 1 (requesting device)
wscat -c "ws://localhost:8001/relay/$SESSION?token=$GRANT_A"

# Terminal 2 (target device)
wscat -c "ws://localhost:8001/relay/$SESSION?token=$GRANT_B"
```

Note that the tunnel carries **binary** frames; wscat's text input is only
useful for checking that authentication and pairing succeed.

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

**What is enforced today**

- A connection must present a session grant minted by the signaling server;
  an account access token is not accepted.
- A grant is bound to one session id, one bearer device, one peer device and
  one account, carries a mandatory short expiry, and is single use.
- A session admits exactly two connections, and only the two devices its
  grants name. A third is closed immediately.
- Total and per-account session caps, a pairing timeout and an idle timeout
  are all enforced.

**What is not**

- **The relay sees plaintext.** It terminates TLS and forwards frames in the
  clear, and meters their size. Operators of a relay are trusted with the
  traffic that crosses it. End-to-end encryption (Noise XX) is roadmap, not
  shipped, so do not describe this path as end-to-end encrypted.
- **No quota enforcement.** Byte counts are logged for accounting; nothing
  refuses service when a user exceeds anything.
- **Sessions are per process.** Run with `--workers 1`; see `deploy/`.

## Session Lifecycle

1. A device presents a grant → the session is created, pinned to that
   grant's account and device pair, and waits for the peer
2. The waiting device is watched, not slept on: it can send frames (buffered
   up to `MAX_PREPAIR_BUFFER_BYTES`), its hangup is noticed immediately, and
   it is disconnected after `PAIR_TIMEOUT` if nobody joins
3. The peer presents its own grant → both connected, forwarding starts and
   the buffer is flushed
4. Any third connection is refused and closed
5. Either side disconnects, or the session is idle for `SESSION_TIMEOUT` →
   close both, log stats

## Logging

Session stats are emitted as JSON on the `lem.relay.metering` logger, so they
can be routed and shipped like any other log stream:

```json
{
  "event": "session_closed",
  "session_id": "0iP2n7...",
  "user_id": 42,
  "devices": ["browser-abc", "local-server-deadbeef"],
  "duration_seconds": 45.2,
  "bytes_by_device": {"browser-abc": 12345, "local-server-deadbeef": 54321},
  "total_bytes": 66666,
  "timestamp": "2025-11-11T12:34:56.789Z"
}
```

Nothing acts on these numbers yet; there is no quota enforcement.

## Configuration

See `app/core/config.py` for all settings. The ones that matter:

| Setting | Default | Purpose |
| --- | --- | --- |
| `SECRET_KEY` | **required** | Shared HS256 key. Must equal the signaling server's. No default; the server refuses to start without it. |
| `CORS_ORIGINS` | **required** | Explicit origin list. `*` is rejected. |
| `PORT` | 8001 | Server port. |
| `SESSION_TIMEOUT` | 300 | Idle timeout for a paired session, in seconds. |
| `PAIR_TIMEOUT` | 30 | How long the first peer waits alone, in seconds. |
| `MAX_PREPAIR_BUFFER_BYTES` | 262144 | Bytes buffered before pairing. |
| `MAX_SESSIONS` | 1000 | Total concurrent sessions per process. |
| `MAX_SESSIONS_PER_USER` | 10 | Concurrent sessions one account may hold. |
