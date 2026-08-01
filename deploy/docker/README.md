# Docker Deployment Guide

Local Docker Compose setup for development and testing.

## Security posture of this stack

Read this before pointing anything at it.

- **This stack is plaintext.** nginx listens on port 80 only; it ships no
  certificates and defines no TLS server block. Port 443 is deliberately not
  published, because mapping it advertised an encrypted endpoint that did not
  exist. Everything on the wire is readable: JWTs, device registrations, and
  the tunnel bytes the relay forwards.
- **Bind it to localhost or a trusted network.** For anything reachable from
  a network, use `deploy/self-hosting/`, whose nginx configs terminate TLS.
- **`SECRET_KEY` is mandatory.** Both services refuse to start without one,
  and reject the example values that used to be committed here. Generate a
  private key before the first `up`; see below.

## Quick Start

```bash
# One-time: generate the shared secret both services need.
# The two services must use the SAME key: signaling mints the relay session
# grants that the relay verifies.
cd deploy/docker
printf 'LEM_SECRET_KEY=%s\n' "$(openssl rand -hex 32)" > .env

# Optional: restrict which browser origins may call the API.
# Defaults to the local dev servers if unset.
# echo 'LEM_CORS_ORIGINS=http://localhost:5173' >> .env

docker-compose up -d

# View logs
docker-compose logs -f

# Test endpoints
curl http://localhost/health        # Signaling via nginx
curl http://localhost:8000/health   # Signaling direct
curl http://localhost:8001/health   # Relay direct
```

## Services

- **PostgreSQL** (port 5432) - Database
- **Signaling** (port 8000) - Signaling server
- **Relay** (port 8001) - Relay server
- **Nginx** (port 80, plaintext) - Reverse proxy and edge rate limiting

## Architecture

```
Browser
  ↓
Nginx (localhost:80)
  ↓
  ├─→ Signaling (localhost:8000)
  │     ↓
  │   PostgreSQL (localhost:5432)
  │
  └─→ Relay (localhost:8001)
```

## Database Access

```bash
# Connect to PostgreSQL
docker exec -it lem-postgres psql -U lemadmin -d signaling

# Useful queries
SELECT * FROM users;
SELECT * FROM devices;
```

## Rebuilding After Code Changes

```bash
# Rebuild specific service
docker-compose build signaling
docker-compose up -d signaling

# Rebuild all
docker-compose build
docker-compose up -d
```

## Cleanup

```bash
# Stop services
docker-compose down

# Remove volumes (WARNING: deletes database)
docker-compose down -v

# Remove all (volumes + images)
docker-compose down -v --rmi all
```

## Environment Variables

`deploy/docker/.env` (not committed) supplies:

| Variable | Required | Purpose |
| --- | --- | --- |
| `LEM_SECRET_KEY` | yes | Shared HS256 key for both services. `openssl rand -hex 32`. Compose fails to start without it. |
| `LEM_CORS_ORIGINS` | no | Comma-separated allowed browser origins. Defaults to the local dev servers. `*` is rejected by both services. |

Everything else (database credentials, ports, timeouts) is in
`docker-compose.yml`.

## Worker count

Both services run with `--workers 1`, and that is not a tuning oversight.
The signaling connection registry, the challenge store, the rate limiters and
the relay session table are all in-process dictionaries. A second worker gets
its own copies, so devices on different workers cannot reach each other and
relay peers never pair. Scaling out needs a shared store first.

## Production Deployment

For AWS deployment, see `../AWS.md`.

## Troubleshooting

### Services won't start
```bash
# Check logs
docker-compose logs

# Check specific service
docker-compose logs signaling
```

### Database connection errors
```bash
# Ensure postgres is healthy
docker-compose ps

# Check database logs
docker-compose logs postgres
```

### `SECRET_KEY` errors on startup
```
Set LEM_SECRET_KEY in deploy/docker/.env - generate with: openssl rand -hex 32
```
Create `deploy/docker/.env` as shown in Quick Start. If the services start but
log a validation error about the secret key, the value is either one of the
rejected example keys or shorter than 32 characters.

### Port conflicts
If ports 80, 8000, 8001, or 5432 are in use:
```bash
# Find process using port
lsof -i :8000

# Edit docker-compose.yml to use different ports
```
