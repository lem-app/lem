# Lem AWS Deployment

Deploy Lem to Amazon Web Services (AWS) using Infrastructure as Code or manual setup.

---

## 📋 Choose Your Deployment Method

### Option 1: AWS CDK (Recommended)

**One-command deployment** using Infrastructure as Code.

```bash
cd cdk/
pnpm install
cdk deploy
```

**Best for:**
- ✅ Production deployments
- ✅ Reproducible infrastructure
- ✅ Fast deployment (20 minutes)
- ✅ Easy updates and rollbacks

**[Get Started → cdk/README.md](./cdk/README.md)**

---

### Option 2: Manual AWS Console

**Step-by-step** deployment using AWS Console.

```
Follow the guide to create:
1. VPC and networking
2. RDS PostgreSQL database
3. ECS Fargate cluster
4. Load Balancers (ALB + NLB)
5. S3 + CloudFront
6. Route 53 DNS
```

**Best for:**
- ✅ Learning AWS services
- ✅ Custom configurations
- ✅ Understanding each component

**[Get Started → manual/GUIDE.md](./manual/GUIDE.md)**

---

## 🔐 AWS Credentials

Both methods require AWS credentials. See **[CREDENTIALS.md](./CREDENTIALS.md)** for:

- AWS CLI setup (`aws configure`)
- Multiple AWS accounts (profiles)
- AWS SSO for organizations
- GitHub Actions with OIDC
- Security best practices

---

## 💰 Cost Estimate

Both methods create the same infrastructure:

**~$125-145/month**

| Service | Monthly Cost |
|---------|--------------|
| ECS Fargate (4 tasks) | $30-50 |
| Application Load Balancer | $20 |
| Network Load Balancer | $20 |
| RDS PostgreSQL (db.t4g.micro) | $15 |
| NAT Gateway | $30 |
| S3 + CloudFront | $5 |
| Secrets Manager, ECR, CloudWatch | $5-10 |

**Cost optimization tips in each guide!**

---

## 🏗️ Infrastructure Created

Both methods create a production-ready AWS architecture:

```
Route 53 (DNS)
  ├─ signal.lem.gg  → ALB → ECS Fargate (Signaling)
  ├─ relay.lem.gg   → NLB → ECS Fargate (Relay)
  └─ app.lem.gg     → CloudFront → S3 (React)

VPC (10.0.0.0/16)
  ├─ Public Subnets (2 AZs) - Load Balancers, NAT
  ├─ Private Subnets (2 AZs) - ECS Tasks
  └─ Isolated Subnets (2 AZs) - RDS PostgreSQL

Auto-Scaling
  ├─ Signaling: 2-10 tasks (CPU/Memory based)
  └─ Relay: 2-10 tasks (CPU based)

Security
  ├─ SSL/TLS (ACM certificates)
  ├─ Secrets Manager (JWT keys, DB password)
  ├─ Security Groups (least privilege)
  └─ Private Subnets (no direct internet access)

Monitoring
  ├─ CloudWatch Logs
  ├─ Container Insights
  └─ Auto-scaling metrics
```

---

## 🚀 Quick Comparison

| Feature | AWS CDK | Manual Console |
|---------|---------|----------------|
| **Deployment Time** | 20 minutes | 2-3 hours |
| **Complexity** | Low | Medium-High |
| **Reproducibility** | High (code) | Low (manual) |
| **Learning Curve** | CDK basics | All AWS services |
| **Updates** | `cdk deploy` | Manual changes |
| **Rollback** | `cdk deploy` previous | Manual restore |
| **Cost** | Same | Same |

---

## 📚 Documentation

- **[cdk/README.md](./cdk/README.md)** - CDK deployment guide
- **[manual/GUIDE.md](./manual/GUIDE.md)** - Manual deployment guide
- **[CREDENTIALS.md](./CREDENTIALS.md)** - AWS authentication

---

## 🎯 Next Steps

1. **Set up AWS credentials** - See [CREDENTIALS.md](./CREDENTIALS.md)
2. **Choose your method:**
   - CDK (fast) → [cdk/README.md](./cdk/README.md)
   - Manual (learn) → [manual/GUIDE.md](./manual/GUIDE.md)
3. **Deploy infrastructure**
4. **Build and push Docker images**
5. **Deploy React app to S3**

---

**Need help?** Check the troubleshooting sections in each guide.

**Last updated:** 2025-11-16
