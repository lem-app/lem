# Lem Deployment Guide

Deploy Lem locally for development or to your own server for production.

---

## 🚀 Quick Start

Choose your deployment method:

| **I want to...** | **Use this method** | **Time** | **Cost** |
|------------------|---------------------|----------|----------|
| Try Lem locally | [Docker Compose](./docker/) | 5 min | Free |
| Deploy to production | [Self-Hosting](./self-hosting/) | 1-2 hours | $5-50/mo |

---

## 📊 Deployment Options

### Docker Compose (Local Development)

**Best for:** Trying Lem, development, testing

```
✅ Pros                          ❌ Cons
• Free                           • Not production-ready
• Fast setup (5 minutes)         • No SSL/HTTPS
• Easy to debug                  • Single machine only
• No cloud account needed        • No high availability
```

**What you get:**
- Signaling server (FastAPI + asyncpg)
- Relay server (WebSocket)
- PostgreSQL database (mimics AWS RDS)
- Nginx reverse proxy (mimics AWS ALB)
- All services networked together

**Note:** The signaling server auto-detects `DATABASE_URL` to use PostgreSQL (Docker/AWS) or SQLite (standalone dev).

**[Get Started →](./docker/)**

---

### Self-Hosting (Your Own Server)

**Best for:** Production deployments with full control

```
✅ Pros                          ❌ Cons
• Full control                   • Manual setup required
• Lower cost ($5-50/mo)          • You manage updates
• No vendor lock-in              • You handle backups
• Runs on Linux/macOS            • You manage monitoring
```

**Requirements:**
- Linux server (Ubuntu/Debian recommended)
- Python 3.12+ installed
- Nginx for reverse proxy
- SSL certificate (Let's Encrypt)
- PostgreSQL database

**What you get:**
- Production-ready deployment
- SSL/TLS encryption
- Systemd service management
- Nginx reverse proxy
- Full control over configuration

**[Get Started →](./self-hosting/)**

---

## 🤔 Decision Tree

```
┌─────────────────────────────────────────────┐
│ What's your goal?                           │
└─────────────────────────────────────────────┘
                 │
        ┌────────┴────────┐
        │                 │
    Development       Production
        │                 │
        ↓                 ↓
  Docker Compose    Self-Hosting
```

---

## 📁 Directory Structure

```
deploy/
├── README.md                    # This file
│
├── docker/                      # Local development
│   ├── README.md               # Quick start guide
│   ├── docker-compose.yml      # Services definition
│   └── nginx.conf              # Local reverse proxy
│
└── self-hosting/                # Production server deployment
    ├── README.md               # Self-hosting guide
    ├── nginx/                  # Nginx configs
    │   ├── signaling.conf      # Signaling reverse proxy
    │   └── relay.conf          # Relay reverse proxy
    └── systemd/                # Systemd services
        ├── lem-signaling.service
        └── lem-relay.service
```

---

## 🔐 Security Notes

All deployment methods include:

✅ **SSL/TLS encryption** (HTTPS/WSS in production)
✅ **Environment-based configuration** (.env files)
✅ **Network isolation** (services communicate internally)
✅ **Secrets management** (environment variables)

**Never commit:**
- `.env` files (local secrets)
- `.env.production` (your production configuration)
- Database passwords
- API keys or tokens

**Safe to commit:**
- `.env.example` (templates)
- `.env.production.example` (template)
- Configuration examples

---

## 💰 Cost Estimates

### Docker Compose
**$0/month** - Runs on your local machine

### Self-Hosting
**$5-50/month** depending on provider:
- DigitalOcean Droplet: $6/mo (basic)
- Linode: $5/mo (nanode)
- Hetzner Cloud: €4.51/mo (~$5)
- Vultr: $6/mo (regular performance)

Plus optional:
- Domain name: $10-15/year
- SSL certificate: Free (Let's Encrypt)

**Recommended specs:**
- **Minimum:** 1GB RAM, 1 CPU, 25GB storage
- **Recommended:** 2GB RAM, 2 CPU, 50GB storage

---

## 🆘 Getting Help

### Common Issues

1. **Docker Compose not starting:**
   - Check Docker is running: `docker info`
   - Check ports 80, 8000, 8001, 5432 are free
   - View logs: `docker-compose logs -f`

2. **Self-hosting connection issues:**
   - Check Nginx is running: `systemctl status nginx`
   - Check firewall allows ports 80, 443
   - Check SSL certificates: `certbot certificates`
   - View service logs: `journalctl -u lem-signaling -f`

### Documentation

- **Main Lem docs:** `/docs/`
- **Implementation plan:** `/docs/implementation_plan.md`
- **API contracts:** `/docs/api.md`
- **Architecture:** `/docs/architecture.md`

### Support

- GitHub Issues: https://github.com/lem/lem/issues
- Discord: [Join our community]

---

## 🎯 Next Steps

1. **Choose your deployment method** from the table above
2. **Follow the guide** in the corresponding directory
3. **Test your deployment** with the verification steps
4. **Monitor and maintain** using the provided tools

**Ready to deploy?** Click one of the "Get Started →" links above!

---

**Last updated:** 2025-11-20
