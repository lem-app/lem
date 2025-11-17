# Lem AWS Deployment Guide

Complete guide for deploying Lem to AWS using modern cloud-native services.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Route 53 (lem.gg)                                               │
│  ├── lem.gg                    → CloudFront → S3 (landing page) │
│  ├── app.lem.gg                → CloudFront → S3 (React app)    │
│  ├── signal.lem.gg             → ALB → ECS/Fargate (signaling) │
│  └── relay.lem.gg              → NLB → ECS/Fargate (relay)      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ VPC (10.0.0.0/16)                                               │
│  ├── Public Subnets (2 AZs)                                     │
│  │   ├── NAT Gateways                                           │
│  │   └── Load Balancers                                         │
│  ├── Private Subnets (2 AZs)                                    │
│  │   ├── ECS Fargate Tasks (signaling + relay)                 │
│  │   └── Auto-scaling (CPU/memory based)                        │
│  └── RDS Subnet Group                                           │
│      └── PostgreSQL (Multi-AZ)                                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Supporting Services                                             │
│  ├── ECR - Container images                                     │
│  ├── Secrets Manager - Environment variables & secrets          │
│  ├── CloudWatch - Logs & metrics                                │
│  ├── ACM - SSL certificates                                     │
│  ├── Systems Manager - Parameter Store (config)                 │
│  └── IAM - Roles & policies                                     │
└─────────────────────────────────────────────────────────────────┘
```

## AWS Services Used

| Service | Purpose | Cost (est.) |
|---------|---------|-------------|
| **ECS Fargate** | Run signaling + relay containers | ~$30-50/month |
| **Application Load Balancer** | HTTPS/WebSocket for signaling | ~$20/month |
| **Network Load Balancer** | WebSocket for relay | ~$20/month |
| **RDS PostgreSQL** | Database (db.t4g.micro) | ~$15/month |
| **S3 + CloudFront** | Static site hosting | ~$1-5/month |
| **Route 53** | DNS | ~$1/month |
| **ACM** | SSL certificates | Free |
| **Secrets Manager** | Secrets storage | ~$1/month |
| **CloudWatch** | Logs & monitoring | ~$5-10/month |
| **ECR** | Container registry | ~$1/month |
| **NAT Gateway** | Outbound internet (2 AZs) | ~$60/month |
| **Total** | | **~$154-183/month** |

### Cost Optimization Tips
- Use **single NAT Gateway** (not HA): Save ~$30/month
- Use **RDS Aurora Serverless v2**: Pay per use
- Use **Fargate Spot**: Save up to 70% on compute
- Use **CloudFront + S3**: Cheaper than EC2 for static content

## Prerequisites

- [x] AWS Account with billing enabled
- [x] Route 53 hosted zone for `lem.gg`
- [x] AWS CLI installed and configured with credentials
  ```bash
  # Configure credentials
  aws configure

  # Verify they work
  aws sts get-caller-identity
  ```
  **Need help with credentials?** See [`aws-cdk/CREDENTIALS.md`](./aws-cdk/CREDENTIALS.md) for complete authentication guide.
- [x] Docker installed locally
- [ ] Domain verification for ACM certificates

## Deployment Options

Choose one:
1. **[Recommended] AWS CDK** (Infrastructure as Code, TypeScript)
2. **CloudFormation** (YAML templates)
3. **Manual AWS Console** (Step-by-step guide below)

---

## Option 1: AWS CDK Deployment (Recommended)

### Why CDK?
- **Type-safe** infrastructure code (TypeScript)
- **Reusable** constructs
- **Version control** friendly
- **Preview changes** before deployment
- **Automatic rollback** on failure

### Quick Start

```bash
# Install CDK
npm install -g aws-cdk

# Navigate to CDK directory
cd deploy/aws-cdk

# Install dependencies
pnpm install

# Bootstrap CDK (first time only)
cdk bootstrap

# Preview changes
cdk diff

# Deploy everything
cdk deploy --all

# Outputs will show:
# - Load balancer URLs
# - CloudFront distribution URLs
# - Database endpoint
```

See `deploy/aws-cdk/README.md` for detailed CDK instructions.

---

## Option 2: Manual AWS Console Deployment

### Phase 1: Networking (VPC, Subnets, Security Groups)

#### 1.1 Create VPC

**AWS Console → VPC → Create VPC**

```
Name: lem-vpc
IPv4 CIDR: 10.0.0.0/16
IPv6: No
Tenancy: Default
```

#### 1.2 Create Subnets

Create 4 subnets across 2 availability zones:

**Public Subnet 1 (us-east-1a)**
```
Name: lem-public-1a
VPC: lem-vpc
AZ: us-east-1a
CIDR: 10.0.1.0/24
Auto-assign IPv4: Yes
```

**Public Subnet 2 (us-east-1b)**
```
Name: lem-public-1b
VPC: lem-vpc
AZ: us-east-1b
CIDR: 10.0.2.0/24
Auto-assign IPv4: Yes
```

**Private Subnet 1 (us-east-1a)**
```
Name: lem-private-1a
VPC: lem-vpc
AZ: us-east-1a
CIDR: 10.0.11.0/24
Auto-assign IPv4: No
```

**Private Subnet 2 (us-east-1b)**
```
Name: lem-private-1b
VPC: lem-vpc
AZ: us-east-1b
CIDR: 10.0.12.0/24
Auto-assign IPv4: No
```

#### 1.3 Create Internet Gateway

**VPC → Internet Gateways → Create**
```
Name: lem-igw
Attach to: lem-vpc
```

#### 1.4 Create NAT Gateway (for private subnet internet access)

**VPC → NAT Gateways → Create**
```
Name: lem-nat-1a
Subnet: lem-public-1a
Elastic IP: Allocate new
```

*Optional: Create second NAT Gateway in lem-public-1b for high availability (costs ~$30/month extra)*

#### 1.5 Create Route Tables

**Public Route Table**
```
Name: lem-public-rt
VPC: lem-vpc
Routes:
  - 0.0.0.0/0 → lem-igw (internet gateway)
  - 10.0.0.0/16 → local
Associate with: lem-public-1a, lem-public-1b
```

**Private Route Table**
```
Name: lem-private-rt
VPC: lem-vpc
Routes:
  - 0.0.0.0/0 → lem-nat-1a (NAT gateway)
  - 10.0.0.0/16 → local
Associate with: lem-private-1a, lem-private-1b
```

#### 1.6 Create Security Groups

**ALB Security Group (for signaling server)**
```
Name: lem-alb-sg
Description: Allow HTTPS traffic to signaling ALB
VPC: lem-vpc

Inbound Rules:
  - Type: HTTPS, Protocol: TCP, Port: 443, Source: 0.0.0.0/0
  - Type: HTTP, Protocol: TCP, Port: 80, Source: 0.0.0.0/0 (redirect to HTTPS)

Outbound Rules:
  - All traffic to 0.0.0.0/0
```

**NLB Security Group (for relay server)**
```
Name: lem-nlb-sg
Description: Allow WebSocket traffic to relay NLB
VPC: lem-vpc

Inbound Rules:
  - Type: HTTPS, Protocol: TCP, Port: 443, Source: 0.0.0.0/0

Outbound Rules:
  - All traffic to 0.0.0.0/0
```

**ECS Tasks Security Group**
```
Name: lem-ecs-sg
Description: Allow traffic from ALB/NLB to ECS tasks
VPC: lem-vpc

Inbound Rules:
  - Type: Custom TCP, Port: 8000, Source: lem-alb-sg (signaling)
  - Type: Custom TCP, Port: 8001, Source: lem-nlb-sg (relay)

Outbound Rules:
  - All traffic to 0.0.0.0/0
```

**RDS Security Group**
```
Name: lem-rds-sg
Description: Allow PostgreSQL from ECS
VPC: lem-vpc

Inbound Rules:
  - Type: PostgreSQL, Protocol: TCP, Port: 5432, Source: lem-ecs-sg

Outbound Rules:
  - All traffic to 0.0.0.0/0
```

---

### Phase 2: Database (RDS PostgreSQL)

**RDS → Create Database**

```
Engine: PostgreSQL 16
Template: Free tier (or Production for Multi-AZ)
DB instance: lem-db
Master username: lemadmin
Master password: <generate strong password, save to Secrets Manager>

Instance configuration:
  - Class: db.t4g.micro (free tier) or db.t4g.small
  - Storage: 20 GB, gp3
  - Auto-scaling: Enable (max 100 GB)

Connectivity:
  - VPC: lem-vpc
  - Subnet group: Create new (lem-private-1a, lem-private-1b)
  - Public access: No
  - Security group: lem-rds-sg
  - AZ: us-east-1a

Database authentication: Password

Additional configuration:
  - Initial database: signaling
  - Backup retention: 7 days
  - Enable encryption
  - Monitoring: Enable Enhanced Monitoring
```

**Save database endpoint** (e.g., `lem-db.xxxxx.us-east-1.rds.amazonaws.com`)

---

### Phase 3: Secrets Manager

**Secrets Manager → Store a new secret**

#### Secret 1: Database Connection String
```
Name: lem/db/connection-string
Type: Other type of secret
Key: DATABASE_URL
Value: postgresql+asyncpg://lemadmin:<password>@lem-db.xxxxx.us-east-1.rds.amazonaws.com:5432/signaling
```

#### Secret 2: JWT Secret Key
```
Name: lem/jwt/secret-key
Type: Other type of secret
Key: SECRET_KEY
Value: <generate with: openssl rand -hex 32>
```

---

### Phase 4: Container Registry (ECR)

**ECR → Create repository**

Create 2 repositories:

```
Repository 1:
  Name: lem-signaling
  Tag immutability: Enabled
  Scan on push: Enabled
  Encryption: AES-256

Repository 2:
  Name: lem-relay
  Tag immutability: Enabled
  Scan on push: Enabled
  Encryption: AES-256
```

#### Build and Push Images

```bash
# Get ECR login
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com

# Build and push signaling server
cd cloud/signaling
docker build -t lem-signaling .
docker tag lem-signaling:latest <account-id>.dkr.ecr.us-east-1.amazonaws.com/lem-signaling:latest
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/lem-signaling:latest

# Build and push relay server
cd ../relay
docker build -t lem-relay .
docker tag lem-relay:latest <account-id>.dkr.ecr.us-east-1.amazonaws.com/lem-relay:latest
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/lem-relay:latest
```

---

### Phase 5: ECS Cluster

**ECS → Clusters → Create Cluster**

```
Cluster name: lem-cluster
Infrastructure: AWS Fargate
Container insights: Enable
```

---

### Phase 6: Load Balancers

#### 6.1 Application Load Balancer (Signaling)

**EC2 → Load Balancers → Create Application Load Balancer**

```
Name: lem-signaling-alb
Scheme: Internet-facing
IP address type: IPv4

Network mapping:
  VPC: lem-vpc
  Subnets: lem-public-1a, lem-public-1b

Security groups: lem-alb-sg

Listeners:
  - Protocol: HTTPS, Port: 443
  - Certificate: Request from ACM for signal.lem.gg

Target group:
  Name: lem-signaling-tg
  Target type: IP
  Protocol: HTTP
  Port: 8000
  VPC: lem-vpc
  Health check path: /health
  Health check interval: 30s
```

#### 6.2 Network Load Balancer (Relay)

**EC2 → Load Balancers → Create Network Load Balancer**

```
Name: lem-relay-nlb
Scheme: Internet-facing
IP address type: IPv4

Network mapping:
  VPC: lem-vpc
  Subnets: lem-public-1a, lem-public-1b

Listeners:
  - Protocol: TLS, Port: 443
  - Certificate: Request from ACM for relay.lem.gg

Target group:
  Name: lem-relay-tg
  Target type: IP
  Protocol: TCP
  Port: 8001
  VPC: lem-vpc
  Health check protocol: HTTP
  Health check path: /health
```

---

### Phase 7: ACM Certificates

**Certificate Manager → Request certificate**

Request certificates for:
1. `signal.lem.gg` (for ALB)
2. `relay.lem.gg` (for NLB)
3. `app.lem.gg` (for CloudFront)

```
Certificate 1:
  Domain: signal.lem.gg
  Validation: DNS (automatic with Route 53)

Certificate 2:
  Domain: relay.lem.gg
  Validation: DNS (automatic with Route 53)

Certificate 3:
  Domain: app.lem.gg
  Validation: DNS (automatic with Route 53)
```

Wait for validation (automatic if using Route 53).

---

### Phase 8: ECS Task Definitions

#### 8.1 Signaling Server Task Definition

**ECS → Task Definitions → Create new task definition**

```
Family: lem-signaling-task
Launch type: Fargate
OS: Linux
CPU: 0.5 vCPU
Memory: 1 GB

Task role: Create new role "lem-ecs-task-role" with:
  - SecretsManagerReadWrite
  - CloudWatchLogsFullAccess

Task execution role: ecsTaskExecutionRole

Container:
  Name: signaling
  Image: <account-id>.dkr.ecr.us-east-1.amazonaws.com/lem-signaling:latest
  Port mappings: 8000 (TCP)

  Environment variables:
    - HOST=0.0.0.0
    - PORT=8000
    - ALGORITHM=HS256
    - ACCESS_TOKEN_EXPIRE_MINUTES=1440
    - CORS_ORIGINS=https://app.lem.gg
    - RELAY_URL=wss://relay.lem.gg

  Secrets (from Secrets Manager):
    - SECRET_KEY → lem/jwt/secret-key:SECRET_KEY
    - DATABASE_URL → lem/db/connection-string:DATABASE_URL

  Logging:
    Log driver: awslogs
    Log group: /ecs/lem-signaling (create if not exists)
    Region: us-east-1
    Stream prefix: ecs
```

#### 8.2 Relay Server Task Definition

**ECS → Task Definitions → Create new task definition**

```
Family: lem-relay-task
Launch type: Fargate
OS: Linux
CPU: 0.5 vCPU
Memory: 1 GB

Task role: lem-ecs-task-role
Task execution role: ecsTaskExecutionRole

Container:
  Name: relay
  Image: <account-id>.dkr.ecr.us-east-1.amazonaws.com/lem-relay:latest
  Port mappings: 8001 (TCP)

  Environment variables:
    - HOST=0.0.0.0
    - PORT=8001
    - ALGORITHM=HS256
    - CORS_ORIGINS=https://app.lem.gg
    - SESSION_TIMEOUT=300
    - WS_PING_INTERVAL=20
    - WS_PING_TIMEOUT=10

  Secrets (from Secrets Manager):
    - SECRET_KEY → lem/jwt/secret-key:SECRET_KEY

  Logging:
    Log driver: awslogs
    Log group: /ecs/lem-relay (create if not exists)
    Region: us-east-1
    Stream prefix: ecs
```

---

### Phase 9: ECS Services

#### 9.1 Signaling Service

**ECS → Clusters → lem-cluster → Create Service**

```
Launch type: Fargate
Task definition: lem-signaling-task:1
Service name: lem-signaling-service
Number of tasks: 2 (for HA)
Platform version: LATEST

Deployment:
  Type: Rolling update
  Min healthy: 100%
  Max healthy: 200%

Networking:
  VPC: lem-vpc
  Subnets: lem-private-1a, lem-private-1b
  Security group: lem-ecs-sg
  Public IP: Disabled

Load balancing:
  Type: Application Load Balancer
  Load balancer: lem-signaling-alb
  Target group: lem-signaling-tg
  Container: signaling:8000

Auto-scaling:
  Min tasks: 2
  Max tasks: 10
  Scaling policy:
    - Metric: CPU > 70%
    - Metric: Memory > 80%
```

#### 9.2 Relay Service

**ECS → Clusters → lem-cluster → Create Service**

```
Launch type: Fargate
Task definition: lem-relay-task:1
Service name: lem-relay-service
Number of tasks: 2 (for HA)
Platform version: LATEST

Deployment:
  Type: Rolling update
  Min healthy: 100%
  Max healthy: 200%

Networking:
  VPC: lem-vpc
  Subnets: lem-private-1a, lem-private-1b
  Security group: lem-ecs-sg
  Public IP: Disabled

Load balancing:
  Type: Network Load Balancer
  Load balancer: lem-relay-nlb
  Target group: lem-relay-tg
  Container: relay:8001

Auto-scaling:
  Min tasks: 2
  Max tasks: 10
  Scaling policy:
    - Metric: CPU > 70%
    - Metric: Connection count > 5000
```

---

### Phase 10: React App (S3 + CloudFront)

#### 10.1 Create S3 Bucket

**S3 → Create bucket**

```
Name: lem-app-frontend (must be globally unique)
Region: us-east-1
Block all public access: Yes (CloudFront will access)
Versioning: Enable
Encryption: Enable (SSE-S3)
```

#### 10.2 Build and Upload React App

```bash
# Build with production environment
cd web/remote
pnpm build

# Upload to S3
aws s3 sync dist/ s3://lem-app-frontend/ --delete
```

#### 10.3 Create CloudFront Distribution

**CloudFront → Create distribution**

```
Origin:
  Domain: lem-app-frontend.s3.amazonaws.com
  Origin path: (empty)
  Origin access: Origin Access Control (OAC)
    - Create new OAC

Default cache behavior:
  Viewer protocol policy: Redirect HTTP to HTTPS
  Allowed HTTP methods: GET, HEAD, OPTIONS
  Cache policy: CachingOptimized
  Origin request policy: CORS-S3Origin

Settings:
  Alternate domain names (CNAMEs): app.lem.gg
  Custom SSL certificate: Select app.lem.gg cert from ACM
  Default root object: index.html

Error pages (for SPA routing):
  - 403 → /index.html (200)
  - 404 → /index.html (200)
```

**Update S3 bucket policy** (CloudFront will provide the policy):
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontOAC",
    "Effect": "Allow",
    "Principal": {
      "Service": "cloudfront.amazonaws.com"
    },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::lem-app-frontend/*",
    "Condition": {
      "StringEquals": {
        "AWS:SourceArn": "arn:aws:cloudfront::<account-id>:distribution/<distribution-id>"
      }
    }
  }]
}
```

---

### Phase 11: Route 53 DNS

**Route 53 → Hosted zones → lem.gg**

Create A records with alias:

```
Record 1:
  Name: signal.lem.gg
  Type: A
  Alias: Yes
  Alias target: lem-signaling-alb (select from list)
  Routing policy: Simple

Record 2:
  Name: relay.lem.gg
  Type: A
  Alias: Yes
  Alias target: lem-relay-nlb (select from list)
  Routing policy: Simple

Record 3:
  Name: app.lem.gg
  Type: A
  Alias: Yes
  Alias target: CloudFront distribution (select from list)
  Routing policy: Simple
```

---

### Phase 12: Verification

Wait 5-10 minutes for DNS propagation, then test:

```bash
# Test signaling server health
curl https://signal.lem.gg/health

# Test relay server health
curl https://relay.lem.gg/health

# Test React app
curl https://app.lem.gg
```

---

## Monitoring & Logging

### CloudWatch Dashboards

**CloudWatch → Dashboards → Create dashboard**

Add widgets for:
- ECS CPU/Memory utilization
- ALB request count, latency, error rate
- NLB active connections
- RDS connections, CPU, storage

### CloudWatch Alarms

Create alarms for:
- ECS CPU > 80% for 5 minutes
- ALB 5xx errors > 10 in 5 minutes
- RDS storage < 20% free
- RDS CPU > 80% for 10 minutes

### CloudWatch Logs Insights

Query ECS logs:
```
fields @timestamp, @message
| filter @message like /ERROR/
| sort @timestamp desc
| limit 100
```

---

## CI/CD Pipeline (Optional)

See `deploy/aws-codepipeline/README.md` for GitHub Actions + AWS CodePipeline integration.

---

## Troubleshooting

### ECS tasks not starting
- Check CloudWatch logs: `/ecs/lem-signaling` or `/ecs/lem-relay`
- Verify secrets exist in Secrets Manager
- Check security groups allow traffic
- Verify ECR images exist

### Can't connect to database
- Check RDS security group allows traffic from ECS security group
- Verify DATABASE_URL is correct in Secrets Manager
- Check RDS instance is in "available" state

### WebSocket connections failing
- For signaling: Check ALB listener supports WebSocket upgrade
- For relay: Use NLB (not ALB) for long-lived WebSocket connections
- Verify security groups allow traffic on ports 8000/8001

### High costs
- Use Fargate Spot (up to 70% savings)
- Reduce NAT Gateway count (1 instead of 2)
- Use Aurora Serverless v2 for database
- Enable S3 Intelligent-Tiering for old objects

---

## Security Checklist

- [ ] Secrets stored in Secrets Manager (not environment variables)
- [ ] RDS in private subnet (no public access)
- [ ] ECS tasks in private subnet
- [ ] Security groups follow least privilege
- [ ] SSL/TLS certificates for all endpoints
- [ ] CloudWatch logs retention set (e.g., 30 days)
- [ ] Enable AWS CloudTrail for audit logs
- [ ] Enable GuardDuty for threat detection
- [ ] Use IAM roles (not access keys) for ECS tasks
- [ ] Enable RDS encryption at rest
- [ ] Regular security patches (rebuild containers monthly)

---

## Cost Optimization

### Current estimate: $154-183/month

**Reduce to ~$80-100/month:**
1. **Single NAT Gateway** (-$30/month): Acceptable for dev/staging
2. **Fargate Spot** (-$20-30/month): 70% discount, automatic failover
3. **RDS Aurora Serverless v2** (-$5-10/month): Pay per use
4. **Reduce ECS task count to 1 each** (-$15-20/month): For dev/staging only

**Production recommendations:**
- Keep 2+ NAT Gateways (HA)
- Keep 2+ ECS tasks per service (HA)
- Use Multi-AZ RDS
- Enable auto-scaling

---

## Next Steps

1. **Create Dockerfiles** for signaling and relay servers (see `deploy/docker/`)
2. **Run CDK deployment** (see `deploy/aws-cdk/`)
3. **Set up CI/CD** (see `deploy/aws-codepipeline/`)
4. **Configure monitoring** (CloudWatch dashboards)
5. **Run load tests** to validate auto-scaling

---

## Support

- **AWS Documentation**: https://docs.aws.amazon.com/
- **ECS Best Practices**: https://docs.aws.amazon.com/AmazonECS/latest/bestpracticesguide/
- **Well-Architected Framework**: https://aws.amazon.com/architecture/well-architected/
