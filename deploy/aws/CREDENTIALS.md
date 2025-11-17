# AWS Credentials for CDK Deployment

Complete guide on authenticating with AWS for CDK deployments.

## How CDK Uses Credentials

AWS CDK uses the **AWS SDK for JavaScript** under the hood, which follows the standard AWS credential provider chain:

1. **Environment variables** (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
2. **AWS CLI credentials** (`~/.aws/credentials`)
3. **AWS CLI config** (`~/.aws/config`)
4. **IAM role** (if running on EC2/ECS/Lambda)
5. **SSO credentials** (AWS SSO login)

CDK will automatically use the first credentials it finds in this order.

---

## Authentication Methods

### Option 1: AWS CLI Configuration (Recommended for Local Development)

This is the **easiest and most common** method.

#### Step 1: Install AWS CLI

```bash
# macOS
brew install awscli

# Linux
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install

# Windows
# Download from: https://awscli.amazonaws.com/AWSCLIV2.msi
```

#### Step 2: Configure Credentials

```bash
aws configure
```

You'll be prompted for:
```
AWS Access Key ID [None]: AKIAIOSFODNN7EXAMPLE
AWS Secret Access Key [None]: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
Default region name [None]: us-east-1
Default output format [None]: json
```

This creates:
- `~/.aws/credentials` - Contains access keys
- `~/.aws/config` - Contains region and output format

#### Step 3: Verify Credentials

```bash
# Check current identity
aws sts get-caller-identity

# Output shows your account, user, and ARN
{
  "UserId": "AIDAIOSFODNN7EXAMPLE",
  "Account": "123456789012",
  "Arn": "arn:aws:iam::123456789012:user/your-username"
}
```

#### Step 4: Deploy with CDK

```bash
cd deploy/aws-cdk

# CDK automatically uses AWS CLI credentials
cdk deploy
```

**Where to get Access Keys:**
1. Log into AWS Console
2. Go to **IAM** → **Users** → Your username
3. **Security credentials** tab
4. **Create access key** → Choose "CLI"
5. Copy **Access Key ID** and **Secret Access Key**

⚠️ **Security Warning**: Never commit access keys to git!

---

### Option 2: Named Profiles (Multiple AWS Accounts)

Use named profiles to manage multiple AWS accounts.

#### Create Multiple Profiles

Edit `~/.aws/credentials`:
```ini
[default]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

[lem-production]
aws_access_key_id = AKIAI44QH8DHBEXAMPLE
aws_secret_access_key = je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY

[lem-staging]
aws_access_key_id = AKIAJHGFD8DHBEXAMPLE
aws_secret_access_key = kl9NvGcDmxCG/3Aq0Vul/i4zDp9owcFEXAMPLEKEY
```

Edit `~/.aws/config`:
```ini
[default]
region = us-east-1

[profile lem-production]
region = us-east-1
output = json

[profile lem-staging]
region = us-west-2
output = json
```

#### Deploy with Specific Profile

```bash
# Method 1: Environment variable
export AWS_PROFILE=lem-production
cdk deploy

# Method 2: Inline
AWS_PROFILE=lem-production cdk deploy

# Method 3: CDK --profile flag
cdk deploy --profile lem-production
```

#### Verify Active Profile

```bash
# Check which profile is active
echo $AWS_PROFILE

# Check account for specific profile
aws sts get-caller-identity --profile lem-production
```

---

### Option 3: AWS SSO (Recommended for Organizations)

If your organization uses AWS SSO (IAM Identity Center), this is the most secure method.

#### Step 1: Configure SSO

```bash
aws configure sso
```

Prompts:
```
SSO session name: lem-sso
SSO start URL: https://your-org.awsapps.com/start
SSO region: us-east-1
SSO registration scopes: sso:account:access
```

This opens a browser for authentication.

#### Step 2: Select Account and Role

After browser login, select:
- AWS account (e.g., "Lem Production")
- IAM role (e.g., "AdministratorAccess")

#### Step 3: Configure Profile

```
CLI default client Region: us-east-1
CLI default output format: json
CLI profile name: lem-prod-sso
```

#### Step 4: Login and Deploy

```bash
# Login (opens browser)
aws sso login --profile lem-prod-sso

# Verify
aws sts get-caller-identity --profile lem-prod-sso

# Deploy
AWS_PROFILE=lem-prod-sso cdk deploy
```

**SSO sessions expire** (typically 8-12 hours). Re-login with:
```bash
aws sso login --profile lem-prod-sso
```

---

### Option 4: Environment Variables (CI/CD)

For automated deployments (GitHub Actions, GitLab CI, etc.).

#### Set Environment Variables

```bash
export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
export AWS_DEFAULT_REGION=us-east-1
```

#### Deploy

```bash
cdk deploy
```

CDK automatically uses environment variables if no credentials file exists.

#### GitHub Actions Example

In your GitHub repo:
1. Go to **Settings** → **Secrets and variables** → **Actions**
2. Add secrets:
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_ACCOUNT_ID`

`.github/workflows/deploy.yml`:
```yaml
name: Deploy CDK

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1

      - name: Install dependencies
        run: |
          cd deploy/aws-cdk
          npm install -g aws-cdk
          pnpm install

      - name: Deploy CDK
        run: |
          cd deploy/aws-cdk
          export HOSTED_ZONE_ID=${{ secrets.HOSTED_ZONE_ID }}
          cdk deploy --require-approval never
```

---

### Option 5: IAM Roles (EC2/ECS/Lambda)

If deploying from an EC2 instance or ECS task, use IAM roles.

#### Create IAM Role

1. **IAM** → **Roles** → **Create role**
2. **Trusted entity**: AWS service → EC2
3. **Permissions**: Attach policies:
   - `AdministratorAccess` (or least-privilege custom policy)
4. Name: `CDKDeploymentRole`

#### Attach Role to EC2

1. EC2 → Select instance
2. **Actions** → **Security** → **Modify IAM role**
3. Select `CDKDeploymentRole`

#### Deploy from EC2

```bash
# SSH into EC2
ssh ec2-user@<instance-ip>

# No credentials needed - role provides them automatically
aws sts get-caller-identity

# Deploy
cd /path/to/lem-app/deploy/aws-cdk
cdk deploy
```

---

## Security Best Practices

### 1. Never Commit Credentials

Add to `.gitignore`:
```
.env
.env.*
.aws/
credentials
*.pem
*.key
```

### 2. Use Least Privilege IAM Policies

Instead of `AdministratorAccess`, create custom policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "cloudformation:*",
        "ec2:*",
        "ecs:*",
        "ecr:*",
        "elasticloadbalancing:*",
        "rds:*",
        "s3:*",
        "cloudfront:*",
        "route53:*",
        "acm:*",
        "secretsmanager:*",
        "logs:*",
        "iam:*",
        "ssm:*"
      ],
      "Resource": "*"
    }
  ]
}
```

### 3. Rotate Access Keys Regularly

```bash
# Create new access key in AWS Console
# Update ~/.aws/credentials with new key
# Test new key works
aws sts get-caller-identity

# Delete old key in AWS Console
```

### 4. Enable MFA for IAM Users

1. IAM → Users → Your user → Security credentials
2. Assign MFA device
3. Configure MFA-protected credentials:

`~/.aws/config`:
```ini
[profile lem-prod-mfa]
role_arn = arn:aws:iam::123456789012:role/YourRole
source_profile = default
mfa_serial = arn:aws:iam::123456789012:mfa/your-username
```

```bash
# Prompts for MFA token
aws sts get-caller-identity --profile lem-prod-mfa
```

### 5. Use AWS Vault (Advanced)

[AWS Vault](https://github.com/99designs/aws-vault) encrypts credentials.

```bash
# Install
brew install --cask aws-vault

# Add credentials
aws-vault add lem-prod

# Use with CDK
aws-vault exec lem-prod -- cdk deploy
```

---

## Troubleshooting

### Error: "Unable to locate credentials"

**Cause**: No credentials configured.

**Solution**:
```bash
aws configure
```

### Error: "The security token included in the request is invalid"

**Cause**:
- SSO session expired
- Access keys deleted
- Wrong region

**Solution**:
```bash
# For SSO
aws sso login --profile your-profile

# For access keys
aws configure
```

### Error: "User is not authorized to perform: cloudformation:CreateStack"

**Cause**: IAM user lacks permissions.

**Solution**:
1. AWS Console → IAM → Users → Your user
2. Add policy: `AdministratorAccess` or custom policy
3. Wait 5 minutes for propagation

### Error: "Account ID mismatch"

**Cause**: Deploying to wrong account.

**Check current account**:
```bash
aws sts get-caller-identity
```

**Fix**:
```bash
# Use correct profile
export AWS_PROFILE=lem-production
```

### Error: "Region not specified"

**Cause**: No default region set.

**Solution**:
```bash
aws configure set region us-east-1

# Or set environment variable
export AWS_DEFAULT_REGION=us-east-1
```

---

## Checking Current Credentials

### View Active Credentials

```bash
# Current identity
aws sts get-caller-identity

# Output:
{
  "UserId": "AIDAIOSFODNN7EXAMPLE",
  "Account": "123456789012",
  "Arn": "arn:aws:iam::123456789012:user/yourname"
}
```

### View Configured Profiles

```bash
# List profiles
aws configure list-profiles

# View specific profile config
aws configure get region --profile lem-production
```

### CDK Context

```bash
# Shows account and region CDK will use
cdk context

# CDK uses:
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=$(aws configure get region)
```

---

## Recommended Setup for Lem

For local development:

```bash
# 1. Configure AWS CLI
aws configure
# Enter your access keys when prompted

# 2. Verify credentials
aws sts get-caller-identity

# 3. Set hosted zone ID
export HOSTED_ZONE_ID=$(aws route53 list-hosted-zones --query "HostedZones[?Name=='lem.gg.'].Id" --output text | cut -d'/' -f3)

# 4. Deploy
cd deploy/aws-cdk
pnpm install
cdk bootstrap
cdk deploy
```

For production/team environments:
- Use **AWS SSO** for centralized access management
- Use **IAM roles** for EC2/ECS deployments
- Use **GitHub Actions with OIDC** (no long-lived keys)

---

## GitHub Actions with OIDC (No Access Keys!)

Most secure method - no access keys needed.

### Step 1: Create OIDC Provider in AWS

1. IAM → Identity providers → Add provider
2. Provider type: OpenID Connect
3. Provider URL: `https://token.actions.githubusercontent.com`
4. Audience: `sts.amazonaws.com`

### Step 2: Create IAM Role for GitHub

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:your-org/lem-app:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

### Step 3: GitHub Actions Workflow

```yaml
name: Deploy CDK

on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/GitHubActionsRole
          aws-region: us-east-1

      - name: Deploy CDK
        run: |
          cd deploy/aws-cdk
          npm install -g aws-cdk
          pnpm install
          cdk deploy --require-approval never
```

**No secrets needed!** GitHub uses OIDC to get temporary credentials.

---

## Summary

**For local development:**
```bash
aws configure  # Easiest method
```

**For teams:**
```bash
aws configure sso  # AWS SSO
```

**For CI/CD:**
- GitHub Actions: Use OIDC (no keys)
- Other CI: Use environment variables with secrets

**CDK automatically uses** whichever credentials are configured - no extra setup needed!
