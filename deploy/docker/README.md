# Docker Deployment Guide

Local Docker Compose setup for development and testing.

## Quick Start

```bash
# From project root
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
- **Nginx** (port 80) - Reverse proxy

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

Edit `docker-compose.yml` to change:
- Database credentials
- CORS origins
- JWT settings
- Ports

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

### Port conflicts
If ports 80, 8000, 8001, or 5432 are in use:
```bash
# Find process using port
lsof -i :8000

# Edit docker-compose.yml to use different ports
```
