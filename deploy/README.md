# Lem Deployment Guide

Complete deployment options for Lem - from local development to production cloud infrastructure.

---

## 🚀 Quick Start

Choose your deployment method based on your needs:

| **I want to...** | **Use this method** | **Time** | **Cost** |
|------------------|---------------------|----------|----------|
| Try Lem locally | [Docker Compose](./docker/) | 5 min | Free |
| Deploy to my own server | [Self-Hosting](./self-hosting/) | 1-2 hours | $5-50/mo |
| Deploy to AWS (one command) | [AWS CDK](./aws/cdk/) | 20 min | $125-145/mo |
| Deploy to AWS (step-by-step) | [AWS Manual](./aws/manual/) | 2-3 hours | $125-145/mo |

---

## 📊 Deployment Comparison

### Docker Compose (Local Development)

**Best for:** Trying Lem, development, testing

```
✅ Pros                          ❌ Cons
• Free                           • Not production-ready
• Fast setup (5 minutes)         • No SSL/HTTPS
• Easy to debug                  • Single machine only
• No cloud account needed        • No high availability
```

**[Get Started →](./docker/)**

---

### Self-Hosting (Your Own Server)

**Best for:** Full control, cost-conscious production

```
✅ Pros                          ❌ Cons
• Full control                   • Manual setup required
• Lower cost ($5-50/mo)          • You manage updates
• No vendor lock-in              • You handle backups
• Runs on Linux/macOS            • No auto-scaling
```

**Requirements:**
- Linux server (Ubuntu/Debian recommended)
- Docker installed OR Python 3.12+
- Nginx for reverse proxy
- SSL certificate (Let's Encrypt)

**[Get Started →](./self-hosting/)**

---

### AWS CDK (Infrastructure as Code)

**Best for:** Production deployments, scalability, automation

```
✅ Pros                          ❌ Cons
• One-command deployment         • AWS costs (~$125-145/mo)
• Auto-scaling                   • Requires AWS account
• High availability              • Cloud vendor lock-in
• Managed services (RDS, etc)    • Learning curve for CDK
• Infrastructure as code
```

**What you get:**
- VPC with multi-AZ subnets
- ECS Fargate (auto-scaling 2-10 tasks)
- RDS PostgreSQL (managed database)
- Application + Network Load Balancers
- S3 + CloudFront (React app CDN)
- SSL certificates (auto-validated)
- CloudWatch logs and monitoring

**[Get Started →](./aws/cdk/)**

---

### AWS Manual (Console Step-by-Step)

**Best for:** Learning AWS, custom configurations

Same infrastructure as CDK, but:
- ✅ Step-by-step instructions
- ✅ Learn each AWS service
- ✅ Customize as you go
- ❌ More time-consuming (2-3 hours)
- ❌ Harder to reproduce

**[Get Started →](./aws/manual/)**

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
  Docker Compose    ┌─────────┐
                    │ Budget? │
                    └─────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
          Tight ($5-50/mo)    Higher ($125-145/mo)
              │                     │
              ↓                     ↓
        Self-Hosting            ┌─────────┐
                                │  Style? │
                                └─────────┘
                                     │
                          ┌──────────┴──────────┐
                          │                     │
                    One-command           Step-by-step
                          │                     │
                          ↓                     ↓
                      AWS CDK              AWS Manual
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
├── self-hosting/                # Traditional server deployment
│   ├── README.md               # Self-hosting guide
│   ├── nginx/                  # Nginx configs
│   │   ├── signaling.conf      # Signaling reverse proxy
│   │   └── relay.conf          # Relay reverse proxy
│   └── systemd/                # Systemd services
│       ├── lem-signaling.service
│       └── lem-relay.service
│
├── aws/                         # AWS cloud deployment
│   ├── README.md               # AWS overview
│   ├── CREDENTIALS.md          # AWS authentication guide
│   │
│   ├── cdk/                    # Infrastructure as Code (recommended)
│   │   ├── README.md           # CDK quick start
│   │   ├── package.json
│   │   ├── cdk.json
│   │   ├── bin/lem-stack.ts    # CDK app
│   │   └── lib/                # Infrastructure definitions
│   │       └── lem-infra-stack.ts
│   │
│   └── manual/                 # Step-by-step console guide
│       └── GUIDE.md            # AWS manual deployment
│
└── scripts/                     # Helper scripts
    └── build-and-push.sh       # Build and push to ECR
```

---

## 🔐 Security Notes

All deployment methods include:

✅ **SSL/TLS encryption** (HTTPS/WSS)
✅ **Environment-based configuration** (.env files)
✅ **Secrets management** (AWS Secrets Manager or environment variables)
✅ **Network isolation** (private subnets, security groups)
✅ **Least privilege** (minimal IAM permissions)

**Never commit:**
- `.env` files (local secrets)
- `.env.production` (your production URLs)
- AWS access keys
- Database passwords

**Safe to commit:**
- `.env.example` (templates)
- `.env.production.example` (template)
- Infrastructure code (CDK stacks)
- Configuration examples

---

## 💰 Cost Estimates

### Docker Compose
**$0/month** - Runs on your local machine

### Self-Hosting
**$5-50/month** depending on provider:
- DigitalOcean Droplet: $6/mo (basic)
- Linode: $5/mo (nanode)
- AWS EC2 t3.small: ~$15/mo
- Hetzner Cloud: €4.51/mo (~$5)

Plus optional:
- Domain name: $10-15/year
- SSL certificate: Free (Let's Encrypt)

### AWS Cloud
**$125-145/month** (estimated):

| Service | Cost |
|---------|------|
| ECS Fargate (4 tasks) | $30-50 |
| Application Load Balancer | $20 |
| Network Load Balancer | $20 |
| RDS PostgreSQL (db.t4g.micro) | $15 |
| NAT Gateway | $30 |
| S3 + CloudFront | $5 |
| Other (Secrets Manager, ECR, logs) | $5-10 |

**Cost optimization tips in each guide!**

---

## 🆘 Getting Help

### Common Issues

1. **Docker Compose not starting:**
   - Check Docker is running: `docker info`
   - Check ports 80, 8000, 8001, 5432 are free
   - View logs: `docker-compose logs`

2. **CDK deployment failed:**
   - Check AWS credentials: `aws sts get-caller-identity`
   - Set HOSTED_ZONE_ID: `export HOSTED_ZONE_ID=<your-zone-id>`
   - See troubleshooting in [CDK README](./aws/cdk/README.md)

3. **Self-hosting connection issues:**
   - Check Nginx is running: `systemctl status nginx`
   - Check firewall allows ports 80, 443
   - Check SSL certificates: `certbot certificates`

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

**Last updated:** 2025-11-16
