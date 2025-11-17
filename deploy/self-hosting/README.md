# Lem Self-Hosting Deployment Guide

Deploy Lem to your own Linux server with Nginx and systemd.

## Directory Structure

```
deploy/self-hosting/
├── README.md                    # This guide
├── nginx/
│   ├── signaling.conf          # Nginx config for signaling server
│   └── relay.conf              # Nginx config for relay server
└── systemd/
    ├── lem-signaling.service   # Systemd unit for signaling
    └── lem-relay.service       # Systemd unit for relay
```

## Prerequisites

- Ubuntu/Debian Linux server
- Nginx installed (`apt install nginx`)
- Systemd (default on Ubuntu/Debian)
- Python with `uv` package manager
- SSL certificates (Let's Encrypt recommended)

## Deployment Steps

### 1. Prepare the Server

```bash
# Create lem user
sudo useradd -r -m -d /opt/lem -s /bin/bash lem

# Install uv for lem user
sudo su - lem
curl -LsSf https://astral.sh/uv/install.sh | sh
exit

# Create directory structure
sudo mkdir -p /opt/lem/cloud/{signaling,relay}
sudo chown -R lem:lem /opt/lem
```

### 2. Deploy Application Code

```bash
# Copy signaling server
sudo cp -r cloud/signaling/* /opt/lem/cloud/signaling/
sudo chown -R lem:lem /opt/lem/cloud/signaling

# Copy relay server
sudo cp -r cloud/relay/* /opt/lem/cloud/relay/
sudo chown -R lem:lem /opt/lem/cloud/relay

# Install dependencies
sudo su - lem
cd /opt/lem/cloud/signaling && uv sync
cd /opt/lem/cloud/relay && uv sync
exit
```

### 3. Configure Environment Variables

```bash
# Signaling server
sudo cp cloud/signaling/.env.example /opt/lem/cloud/signaling/.env
sudo nano /opt/lem/cloud/signaling/.env
# Update: SECRET_KEY, DATABASE_URL, CORS_ORIGINS, RELAY_URL

# Relay server
sudo cp cloud/relay/.env.example /opt/lem/cloud/relay/.env
sudo nano /opt/lem/cloud/relay/.env
# Update: SECRET_KEY, CORS_ORIGINS

# Ensure correct ownership
sudo chown lem:lem /opt/lem/cloud/signaling/.env
sudo chown lem:lem /opt/lem/cloud/relay/.env
sudo chmod 600 /opt/lem/cloud/signaling/.env
sudo chmod 600 /opt/lem/cloud/relay/.env
```

### 4. Install Systemd Services

```bash
# Copy service files
sudo cp deploy/systemd/lem-signaling.service /etc/systemd/system/
sudo cp deploy/systemd/lem-relay.service /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload

# Enable services (start on boot)
sudo systemctl enable lem-signaling
sudo systemctl enable lem-relay

# Start services
sudo systemctl start lem-signaling
sudo systemctl start lem-relay

# Check status
sudo systemctl status lem-signaling
sudo systemctl status lem-relay
```

### 5. Setup SSL Certificates (Let's Encrypt)

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Obtain certificates
sudo certbot certonly --nginx -d signal.lem.gg
sudo certbot certonly --nginx -d relay.lem.gg

# Certificates will be saved to:
# /etc/letsencrypt/live/signal.lem.gg/
# /etc/letsencrypt/live/relay.lem.gg/
```

### 6. Configure Nginx

```bash
# Copy nginx configs
sudo cp deploy/nginx/signaling.conf /etc/nginx/sites-available/signal.lem.gg
sudo cp deploy/nginx/relay.conf /etc/nginx/sites-available/relay.lem.gg

# Enable sites
sudo ln -s /etc/nginx/sites-available/signal.lem.gg /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/relay.lem.gg /etc/nginx/sites-enabled/

# Test nginx config
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx
```

### 7. Configure DNS

Add DNS records pointing to your server IP:

```
signal.lem.gg  →  A record  →  <server-ip>
relay.lem.gg   →  A record  →  <server-ip>
```

### 8. Verify Deployment

```bash
# Check signaling server
curl https://signal.lem.gg/health

# Check relay server
curl https://relay.lem.gg/health

# View logs
sudo journalctl -u lem-signaling -f
sudo journalctl -u lem-relay -f
```

## Production Environment Variables

### Signaling Server (.env)

```bash
SECRET_KEY=<generate-strong-random-key>
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=1440
DATABASE_URL=postgresql+asyncpg://user:password@localhost/signaling
HOST=0.0.0.0
PORT=8000
CORS_ORIGINS=https://lem.gg,https://app.lem.gg
MAX_CONNECTIONS_PER_SECOND=5
RELAY_URL=wss://relay.lem.gg
```

### Relay Server (.env)

```bash
SECRET_KEY=<same-as-signaling-server>
ALGORITHM=HS256
HOST=0.0.0.0
PORT=8001
CORS_ORIGINS=https://lem.gg,https://app.lem.gg
SESSION_TIMEOUT=300
WS_PING_INTERVAL=20
WS_PING_TIMEOUT=10
```

## Service Management

```bash
# Start services
sudo systemctl start lem-signaling
sudo systemctl start lem-relay

# Stop services
sudo systemctl stop lem-signaling
sudo systemctl stop lem-relay

# Restart services
sudo systemctl restart lem-signaling
sudo systemctl restart lem-relay

# View status
sudo systemctl status lem-signaling
sudo systemctl status lem-relay

# View logs (live)
sudo journalctl -u lem-signaling -f
sudo journalctl -u lem-relay -f

# View logs (last 100 lines)
sudo journalctl -u lem-signaling -n 100
sudo journalctl -u lem-relay -n 100
```

## Updating Services

```bash
# Pull latest code
cd /path/to/lem-app
git pull

# Copy updated code
sudo cp -r cloud/signaling/* /opt/lem/cloud/signaling/
sudo cp -r cloud/relay/* /opt/lem/cloud/relay/
sudo chown -R lem:lem /opt/lem/cloud

# Update dependencies
sudo su - lem
cd /opt/lem/cloud/signaling && uv sync
cd /opt/lem/cloud/relay && uv sync
exit

# Restart services
sudo systemctl restart lem-signaling
sudo systemctl restart lem-relay
```

## Troubleshooting

### Check if services are running
```bash
sudo systemctl status lem-signaling
sudo systemctl status lem-relay
```

### Check service logs
```bash
sudo journalctl -u lem-signaling -n 100 --no-pager
sudo journalctl -u lem-relay -n 100 --no-pager
```

### Check nginx logs
```bash
sudo tail -f /var/log/nginx/error.log
sudo tail -f /var/log/nginx/access.log
```

### Test backend directly (bypass nginx)
```bash
curl http://localhost:8000/health
curl http://localhost:8001/health
```

### Check listening ports
```bash
sudo netstat -tlnp | grep -E ':(8000|8001|443)'
```

## Security Notes

1. **Never commit .env files** - They contain secrets
2. **Use strong SECRET_KEY** - Generate with: `openssl rand -hex 32`
3. **Keep SECRET_KEY identical** - Signaling and relay must match for JWT verification
4. **Use PostgreSQL in production** - SQLite is for development only
5. **Enable UFW firewall** - Only allow ports 80, 443, and SSH
6. **Regular updates** - Keep system and packages updated
7. **Monitor logs** - Set up log aggregation and alerting

## Performance Tuning

### For high traffic, adjust systemd service workers:

**Signaling server:**
```
--workers 8  # 2x CPU cores
```

**Relay server:**
```
--workers 4  # 1x CPU cores (WebSocket connections are long-lived)
```

### Nginx tuning for WebSocket:

```nginx
# /etc/nginx/nginx.conf
worker_processes auto;
worker_rlimit_nofile 200000;

events {
    worker_connections 10000;
    use epoll;
}
```

## Monitoring

Consider setting up:
- **Prometheus + Grafana** - Metrics and dashboards
- **Sentry** - Error tracking
- **Datadog/New Relic** - APM
- **Uptime monitors** - Health check alerts
