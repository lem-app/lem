# Lem Signaling Server

WebRTC signaling server for Lem Phase 2.1 - Cloud infrastructure for peer connection establishment.

## Features

- JWT authentication (email/password)
- Device registration with public key storage
- WebSocket-based SDP/ICE message exchange
- SQLite database for v0.1 (single user, single device)
- Type-safe with mypy strict mode
- Comprehensive test coverage

## Quick Start

### Installation

```bash
cd cloud/signaling
uv sync
```

### Run Server

```bash
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --log-level info
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

```bash
curl -X POST http://localhost:8000/devices/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{"device_id":"device-123","pubkey":"ed25519-pubkey-here"}'
```

### List Devices

```bash
curl http://localhost:8000/devices/ \
  -H "Authorization: Bearer <TOKEN>"
```

## WebSocket Signaling

### Connect

```bash
# Using wscat (install: npm install -g wscat)
wscat -c "ws://localhost:8000/signal?token=<JWT>&device_id=<DEVICE_ID>"
```

### Message Format

After connecting, you'll receive a confirmation:
```json
{
  "type": "connected",
  "device_id": "your-device-id",
  "message": "Connected to signaling server"
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

- Passwords hashed with bcrypt
- JWT tokens for authentication (HS256)
- Token expiration: 24 hours
- Device ownership verification
- Message size limit: 64 KB
- WebSocket authentication via query parameters

## Configuration

Environment variables (optional):

```bash
# JWT Settings
SECRET_KEY=your-secret-key-here
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=1440

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
