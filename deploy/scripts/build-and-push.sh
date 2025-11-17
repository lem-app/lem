#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2025 Lem

# Build and push Docker images to AWS ECR
# Usage: ./build-and-push.sh <aws-account-id> <region> [service]
#   service: signaling, relay, or all (default: all)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check arguments
if [ $# -lt 2 ]; then
    echo -e "${RED}Usage: $0 <aws-account-id> <region> [service]${NC}"
    echo "  service: signaling, relay, or all (default: all)"
    exit 1
fi

AWS_ACCOUNT_ID=$1
AWS_REGION=$2
SERVICE=${3:-all}

# ECR repository URLs
SIGNALING_REPO="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/lem-signaling"
RELAY_REPO="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/lem-relay"

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Lem AWS ECR Build and Push${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "AWS Account: ${AWS_ACCOUNT_ID}"
echo "AWS Region: ${AWS_REGION}"
echo "Service: ${SERVICE}"
echo ""

# Login to ECR
echo -e "${YELLOW}[1/4] Logging in to AWS ECR...${NC}"
aws ecr get-login-password --region "${AWS_REGION}" | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# Get git commit hash for tagging
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo ""
echo "Git commit: ${GIT_COMMIT}"
echo "Timestamp: ${TIMESTAMP}"
echo ""

# Function to build and push a service
build_and_push() {
    local service_name=$1
    local service_dir=$2
    local repo_url=$3

    echo -e "${YELLOW}[2/4] Building ${service_name} image...${NC}"
    cd "${service_dir}"
    docker build -t "lem-${service_name}:latest" \
                 -t "lem-${service_name}:${GIT_COMMIT}" \
                 -t "lem-${service_name}:${TIMESTAMP}" \
                 -t "${repo_url}:latest" \
                 -t "${repo_url}:${GIT_COMMIT}" \
                 -t "${repo_url}:${TIMESTAMP}" \
                 .

    echo ""
    echo -e "${YELLOW}[3/4] Tagging ${service_name} image...${NC}"
    echo "Tags:"
    echo "  - ${repo_url}:latest"
    echo "  - ${repo_url}:${GIT_COMMIT}"
    echo "  - ${repo_url}:${TIMESTAMP}"

    echo ""
    echo -e "${YELLOW}[4/4] Pushing ${service_name} image to ECR...${NC}"
    docker push "${repo_url}:latest"
    docker push "${repo_url}:${GIT_COMMIT}"
    docker push "${repo_url}:${TIMESTAMP}"

    echo ""
    echo -e "${GREEN}✓ ${service_name} image pushed successfully!${NC}"
    echo ""
}

# Navigate to project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/../.."

# Build and push based on service argument
if [ "${SERVICE}" = "signaling" ] || [ "${SERVICE}" = "all" ]; then
    build_and_push "signaling" "./cloud/signaling" "${SIGNALING_REPO}"
fi

if [ "${SERVICE}" = "relay" ] || [ "${SERVICE}" = "all" ]; then
    build_and_push "relay" "./cloud/relay" "${RELAY_REPO}"
fi

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}All images pushed successfully!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Next steps:"
echo "  1. Update ECS task definitions with new image tags"
echo "  2. Deploy to ECS: aws ecs update-service --cluster lem-cluster --service lem-signaling-service --force-new-deployment"
echo "  3. Monitor deployment: aws ecs describe-services --cluster lem-cluster --services lem-signaling-service"
echo ""
