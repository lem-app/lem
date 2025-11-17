# Lem AWS CDK Deployment

Infrastructure as Code for deploying Lem to AWS using AWS CDK (TypeScript).

## What Gets Deployed

This CDK stack creates a complete production infrastructure:

- **VPC** (10.0.0.0/16) with public, private, and isolated subnets across 2 AZs
- **RDS PostgreSQL** (db.t4g.micro) in isolated subnets
- **ECS Fargate** cluster with signaling and relay services
- **Application Load Balancer** for signaling server (HTTPS)
- **Network Load Balancer** for relay server (WebSocket/TLS)
- **S3 + CloudFront** for React app hosting
- **Route 53** DNS records for signal.lem.gg, relay.lem.gg, app.lem.gg
- **ACM certificates** (automatic DNS validation)
- **Secrets Manager** for JWT keys and database credentials
- **ECR repositories** for Docker images
- **CloudWatch** logs and monitoring
- **Auto-scaling** for ECS services (2-10 tasks)

## Prerequisites

1. **AWS Account** with credentials configured
   ```bash
   # Configure AWS CLI (easiest method)
   aws configure

   # Enter your AWS Access Key ID and Secret Access Key when prompted
   # Get these from: AWS Console → IAM → Users → Your user → Security credentials

   # Verify credentials work
   aws sts get-caller-identity
   ```

   **New to AWS credentials?** See [`CREDENTIALS.md`](./CREDENTIALS.md) for detailed authentication guide including:
   - AWS CLI setup
   - Multiple AWS accounts (profiles)
   - AWS SSO for organizations
   - GitHub Actions with OIDC
   - Security best practices

2. **Node.js** 18+ and pnpm
   ```bash
   node --version  # Should be 18+
   pnpm --version
   ```

3. **AWS CDK** installed
   ```bash
   npm install -g aws-cdk
   cdk --version
   ```

4. **Route 53 Hosted Zone** for lem.gg
   ```bash
   # Get your hosted zone ID
   aws route53 list-hosted-zones | grep lem.gg
   ```

5. **Docker** running (for building images)
   ```bash
   docker info
   ```

## Quick Start

### Step 1: Install Dependencies

```bash
cd deploy/aws-cdk
pnpm install
```

### Step 2: Set Environment Variables

```bash
# Set your Route 53 hosted zone ID
export HOSTED_ZONE_ID="Z1234567890ABC"

# Verify your AWS credentials
aws sts get-caller-identity
```

### Step 3: Bootstrap CDK (First Time Only)

```bash
cdk bootstrap
```

This creates an S3 bucket and ECR repository for CDK deployments.

### Step 4: Preview Changes

```bash
cdk diff
```

Review the infrastructure that will be created.

### Step 5: Deploy Infrastructure

```bash
cdk deploy
```

Answer "y" when prompted. Deployment takes ~15-20 minutes.

### Step 6: Build and Push Docker Images

```bash
# Get account ID and region
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=$(aws configure get region)

# Build and push images
cd ../..
./deploy/scripts/build-and-push.sh $AWS_ACCOUNT_ID $AWS_REGION
```

### Step 7: Deploy React App

```bash
cd web/remote

# Build production app
pnpm build

# Upload to S3 (get bucket name from CDK outputs)
aws s3 sync dist/ s3://lem-app-<account-id>/ --delete

# Invalidate CloudFront cache
aws cloudfront create-invalidation \
  --distribution-id <distribution-id> \
  --paths "/*"
```

### Step 8: Verify Deployment

```bash
# Test signaling server
curl https://signal.lem.gg/health

# Test relay server
curl https://relay.lem.gg/health

# Open React app
open https://app.lem.gg
```

## CDK Commands

```bash
# Preview changes
cdk diff

# Deploy all stacks
cdk deploy

# Deploy specific stack
cdk deploy LemInfraStack

# Destroy infrastructure (WARNING: deletes everything)
cdk destroy

# Synthesize CloudFormation template
cdk synth

# List all stacks
cdk list

# Watch for changes (auto-deploy)
cdk watch
```

## Configuration

Edit `bin/lem-stack.ts` to customize:

```typescript
const config = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1', // Change region here
  },
  domainName: 'lem.gg', // Your domain
  hostedZoneId: process.env.HOSTED_ZONE_ID,
};
```

Edit `lib/lem-infra-stack.ts` to change:
- Instance sizes (RDS, ECS tasks)
- Auto-scaling limits
- NAT gateway count (1 vs 2 for HA)
- Multi-AZ for RDS
- Log retention periods

## Cost Optimization

### Current estimated cost: ~$154-183/month

**Reduce to ~$80-100/month:**

1. **Use single NAT Gateway** (already configured)
   - Edit: Line 54 - `natGateways: 1`
   - Saves: ~$30/month

2. **Use Fargate Spot**
   ```typescript
   capacityProviderStrategies: [{
     capacityProvider: 'FARGATE_SPOT',
     weight: 1,
   }]
   ```
   - Saves: ~$20-30/month

3. **Reduce RDS instance size**
   ```typescript
   instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO)
   ```
   - Already configured

4. **Reduce auto-scaling minimums** (dev/staging only)
   ```typescript
   desiredCount: 1, // Instead of 2
   minCapacity: 1,  // Instead of 2
   ```

## Updating Services

### Update Docker Images

```bash
# Rebuild and push
./deploy/scripts/build-and-push.sh $AWS_ACCOUNT_ID $AWS_REGION

# Force new deployment
aws ecs update-service \
  --cluster lem-cluster \
  --service lem-signaling-service \
  --force-new-deployment

aws ecs update-service \
  --cluster lem-cluster \
  --service lem-relay-service \
  --force-new-deployment
```

### Update React App

```bash
cd web/remote
pnpm build
aws s3 sync dist/ s3://lem-app-$AWS_ACCOUNT_ID/ --delete
aws cloudfront create-invalidation \
  --distribution-id $DISTRIBUTION_ID \
  --paths "/*"
```

### Update Infrastructure

```bash
# Edit lib/lem-infra-stack.ts
# Then:
cdk diff   # Preview changes
cdk deploy # Apply changes
```

## Monitoring

### CloudWatch Logs

```bash
# View signaling logs
aws logs tail /aws/ecs/lem-signaling --follow

# View relay logs
aws logs tail /aws/ecs/lem-relay --follow
```

### CloudWatch Metrics

Open AWS Console → CloudWatch → Container Insights → lem-cluster

Monitor:
- CPU utilization
- Memory utilization
- Task count
- Network traffic

### Alarms

Create alarms in CloudWatch:
- ECS CPU > 80%
- RDS storage < 20%
- ALB 5xx errors > 10

## Troubleshooting

### CDK Bootstrap Error

```bash
# Ensure you have the correct credentials
aws sts get-caller-identity

# Bootstrap with explicit account/region
cdk bootstrap aws://<account-id>/us-east-1
```

### ECS Tasks Not Starting

```bash
# Check task logs
aws logs tail /aws/ecs/lem-signaling --follow

# Check task status
aws ecs describe-services \
  --cluster lem-cluster \
  --services lem-signaling-service
```

### Certificate Validation Timeout

ACM certificates require DNS validation. If stuck:
- Check Route 53 has CNAME records for validation
- Wait up to 30 minutes for DNS propagation
- Ensure hosted zone ID is correct

### Database Connection Errors

```bash
# Check security groups allow traffic
# Check secrets manager has correct password

# Test from ECS task
aws ecs execute-command \
  --cluster lem-cluster \
  --task <task-id> \
  --container signaling \
  --interactive \
  --command "/bin/sh"
```

### High Costs

Check:
- NAT Gateway count (should be 1 for dev)
- ECS task count (reduce min capacity)
- RDS instance type (use t4g.micro)
- Enable auto-scaling to reduce idle tasks

## Security

### Secrets Rotation

```bash
# Rotate JWT secret
aws secretsmanager rotate-secret \
  --secret-id lem/jwt/secret-key

# Rotate database password
aws secretsmanager rotate-secret \
  --secret-id lem/db/credentials
```

After rotation, restart ECS services:
```bash
aws ecs update-service \
  --cluster lem-cluster \
  --service lem-signaling-service \
  --force-new-deployment
```

### IAM Policies

CDK automatically creates least-privilege IAM roles for:
- ECS task execution (pull images, read secrets)
- ECS task role (application permissions)

Review in IAM console after deployment.

## CI/CD Integration

### GitHub Actions

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to AWS

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1

      - name: Login to ECR
        run: |
          aws ecr get-login-password --region us-east-1 | \
          docker login --username AWS --password-stdin \
          ${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.us-east-1.amazonaws.com

      - name: Build and push images
        run: |
          ./deploy/scripts/build-and-push.sh \
          ${{ secrets.AWS_ACCOUNT_ID }} us-east-1

      - name: Deploy to ECS
        run: |
          aws ecs update-service --cluster lem-cluster \
          --service lem-signaling-service --force-new-deployment
          aws ecs update-service --cluster lem-cluster \
          --service lem-relay-service --force-new-deployment
```

## Backup and Disaster Recovery

### Database Backups

- **Automated backups**: 7 days retention (configurable)
- **Manual snapshots**: Create before major changes
  ```bash
  aws rds create-db-snapshot \
    --db-instance-identifier lem-signaling-db \
    --db-snapshot-identifier lem-db-$(date +%Y%m%d)
  ```

### Infrastructure Recovery

All infrastructure is defined in code. To recover:
```bash
cdk deploy
```

Database data is preserved in snapshots (automatic on deletion).

## Clean Up

**WARNING: This deletes all resources including databases**

```bash
# Delete infrastructure
cdk destroy

# Verify all resources deleted
aws cloudformation list-stacks \
  --stack-status-filter DELETE_COMPLETE
```

Note: ECR repositories and RDS snapshots are retained by default.

## Support

- **AWS CDK Docs**: https://docs.aws.amazon.com/cdk/
- **ECS Best Practices**: https://docs.aws.amazon.com/AmazonECS/latest/bestpracticesguide/
- **Troubleshooting**: See `../AWS.md` for common issues

## Next Steps

1. **Set up monitoring**: CloudWatch dashboards and alarms
2. **Enable auto-scaling**: Based on traffic patterns
3. **Configure backups**: Automated database backups
4. **Set up CI/CD**: GitHub Actions or AWS CodePipeline
5. **Load testing**: Verify performance under load
