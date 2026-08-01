# Lem Signaling Server

WebRTC signaling server for Lem Phase 2.1 - Cloud infrastructure for peer connection establishment.

## Features

- JWT authentication (email/password), rate limited per IP and per account
- Device registration with ed25519 proof of possession
- WebSocket-based SDP/ICE message exchange, restricted to devices the
  authenticated user owns
- Mints unguessable, single-use relay session grants
- SQLite database for v0.1 (single user, single device)
- Type-safe with mypy strict mode
- Comprehensive test coverage

## Quick Start

### Installation

```bash
cd cloud/signaling
uv sync
```

### Configure

`SECRET_KEY` and `CORS_ORIGINS` are **mandatory and have no defaults**; the
server refuses to start without them. See `.env.example`.

```bash
cp .env.example .env
printf 'SECRET_KEY=%s\n' "$(openssl rand -hex 32)" >> .env
```

The relay server must use the **same** `SECRET_KEY`: this server mints the
session grants the relay verifies.

### Run Server

```bash
# Single worker, and 64 KB frames rejected at the transport. See deploy/ for
# why the worker count is not a tuning knob.
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 \
  --workers 1 --ws-max-size 65536 --log-level info
```

The server will be available at `http://localhost:8000`.

### Development

```bash
# Install with dev dependencies
uv sync --all-extras

# Run tests
uv run pytest

# Type checking
uv run mypy app/

# Linting
uv run ruff check app/

# Format code
uv run ruff format app/
```

## API Endpoints

### Health Check

```bash
curl http://localhost:8000/health
```

### Register User

```bash
curl -X POST http://localhost:8000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"testpass123"}'
```

Response:
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "bearer"
}
```

### Login

```bash
curl -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"testpass123"}'
```

### Register Device

Registration is a two-step proof of possession. The stored public key is only
meaningful if the device proves it holds the matching private key.

```bash
# 1. Ask for a challenge
curl -X POST http://localhost:8000/devices/challenge \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{"device_id":"device-123"}'
# -> {"device_id":"device-123","challenge":"<b64>",
#     "context":"lem-device-register-v1","expires_in":120}

# 2. Sign it and register
curl -X POST http://localhost:8000/devices/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{"device_id":"device-123","pubkey":"<b64 raw ed25519 public key>",
       "challenge":"<the challenge>","signature":"<b64 ed25519 signature>"}'
```

The signed message is the byte string:

```
<context> ":" <device_id> ":" <challenge>
```

with `context` = `lem-device-register-v1`, `device_id` UTF-8 encoded, and
`challenge` the ASCII base64 string exactly as issued. `pubkey` must be the
base64 of the 32 raw ed25519 public key bytes; anything else is a 422.
Challenges are single use and expire after `CHALLENGE_TTL_SECONDS`.

### List Devices

```bash
curl http://localhost:8000/devices/ \
  -H "Authorization: Bearer <TOKEN>"
```

## WebSocket Signaling

### Connect

The handshake has three steps. Credentials may come from query parameters
(deprecated: they end up in logs) or from a first `auth` message, but the
ed25519 challenge/response is always required.

```
client -> {"type":"auth","token":"<JWT>","device_id":"<DEVICE_ID>"}
server -> {"type":"challenge","device_id":"<DEVICE_ID>","challenge":"<b64>",
           "context":"lem-signaling-connect-v1"}
client -> {"type":"auth-response","signature":"<b64 ed25519 signature>"}
server -> {"type":"connected","device_id":"<DEVICE_ID>","ice_servers":[...]}
```

The signed message has the same shape as registration, with `context` =
`lem-signaling-connect-v1`. The challenge is fresh per connection and never
reusable. A failure at any step produces an `error` frame and a 1008 close.

### Message Format

After the handshake you receive a confirmation:
```json
{
  "type": "connected",
  "device_id": "your-device-id",
  "message": "Connected to signaling server",
  "ice_servers": [{"urls": "stun:stun.l.google.com:19302"}]
}
```

### Send SDP/ICE Messages

```json
{
  "type": "offer",
  "target_device_id": "target-device-123",
  "payload": {
    "sdp": "v=0\r\no=...",
    "type": "offer"
  }
}
```

The server will route the message to the target device and send an acknowledgment:
```json
{
  "type": "ack",
  "message": "Message delivered to target-device-123"
}
```

### Message Types

- `offer` - WebRTC offer (SDP)
- `answer` - WebRTC answer (SDP)
- `ice-candidate` - ICE candidate
- `connect-request` / `connect-ack` - relay coordination, below

**Every message is routed only to a device the authenticated user owns.**
Naming any other device answers `{"type":"error","message":"Target device is
not available"}` — the same answer given for a device that does not exist and
for one of your own that is offline, so the endpoint cannot be used to probe
who is online.

### Relay Coordination

```json
{
  "type": "connect-request",
  "target_device_id": "your-other-device",
  "preferred_transport": "relay"
}
```

The server mints the session and both grants. Any `relay_session_id` supplied
by the client is ignored: a client-chosen id was guessable, which is what let
a stranger join the resulting relay session.

The requester receives:
```json
{
  "type": "connect-request-sent",
  "target_device_id": "your-other-device",
  "relay_session_id": "<unguessable, server-minted>",
  "relay_url": "wss://relay.lem.gg",
  "relay_token": "<grant for THIS device>",
  "relay_token_expires_in": 120
}
```

The target receives the mirror image:
```json
{
  "type": "connect-request-received",
  "from_device_id": "the-requesting-device",
  "preferred_transport": "relay",
  "relay_session_id": "<the same id>",
  "relay_url": "wss://relay.lem.gg",
  "relay_token": "<grant for THAT device>",
  "relay_token_expires_in": 120
}
```

Each side connects to `{relay_url}/relay/{relay_session_id}` with **its own**
`relay_token`. The tokens are not interchangeable and an account access token
is not accepted by the relay.

## Architecture

### Database Schema

**users**
- `id` (INTEGER PRIMARY KEY)
- `email` (TEXT UNIQUE)
- `hashed_password` (TEXT)
- `created_at` (TIMESTAMP)

**devices**
- `id` (TEXT PRIMARY KEY) - Device ID
- `user_id` (INTEGER FK)
- `pubkey` (TEXT) - Device public key
- `created_at` (TIMESTAMP)

### Security

- Passwords hashed with bcrypt; inputs over bcrypt's 72-byte limit are
  rejected rather than silently truncated
- JWT tokens for authentication (HS256), algorithm pinned, `exp` required
- Token expiration: 24 hours
- `SECRET_KEY` and `CORS_ORIGINS` are mandatory; the published example keys
  and wildcard CORS are refused outright
- Devices prove possession of their ed25519 private key at registration and
  at every signaling connection
- Messages are routed only between devices belonging to the authenticated
  user, with a uniform error for everything else
- Relay sessions are server-minted, unguessable, and bound by a signed grant
  to exactly two devices of one account
- Message size limit: 64 KB, checked before parsing and at the transport via
  uvicorn's `--ws-max-size`
- Per-IP and per-account rate limiting on registration, login and WebSocket
  handshakes

## Configuration

See `.env.example` for the full list. `SECRET_KEY` and `CORS_ORIGINS` are
required; everything else has a working default.

```bash
# JWT Settings - SECRET_KEY is REQUIRED (openssl rand -hex 32)
SECRET_KEY=
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=1440

# CORS - REQUIRED. "*" is rejected: this API is credentialed.
CORS_ORIGINS=http://localhost:5173,http://localhost:5174

# Database
DATABASE_URL=sqlite+aiosqlite:///./signaling.db

# Server
HOST=0.0.0.0
PORT=8000
```

## Testing

Run the test suite:

```bash
uv run pytest
```

Run with coverage:

```bash
uv run pytest --cov=app --cov-report=term-missing
```

Type checking:

```bash
uv run mypy app/
```

Linting:

```bash
uv run ruff check app/
```

## Acceptance Criteria

✅ Can register and login users
✅ Can register devices with public keys
✅ WebSocket connects with JWT token
✅ Routes SDP/ICE messages between peers
✅ All type checks pass (mypy strict)
✅ All linting passes (ruff)
✅ Comprehensive test coverage

## Phase 2.1 Complete

This signaling server implements all requirements for Phase 2.1:
- FastAPI + WebSocket endpoint `/signal`
- JWT authentication (`/auth/login`, `/auth/register`)
- Device registration (SQLite storage)
- SDP/ICE message routing between peers

## Next Steps (Phase 2.2+)

- Deploy to `signal.lem.gg`
- Add TLS/WSS support
- Implement rate limiting
- Add connection metrics
- Migrate to PostgreSQL for production
- Multi-user support
