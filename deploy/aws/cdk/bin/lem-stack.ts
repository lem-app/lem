#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025 Lem

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { LemInfraStack } from '../lib/lem-infra-stack';

const app = new cdk.App();

// Configuration
const config = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  domainName: 'lem.gg',
  // Provide your hosted zone ID from Route 53
  hostedZoneId: process.env.HOSTED_ZONE_ID || '',
};

new LemInfraStack(app, 'LemInfraStack', {
  env: config.env,
  domainName: config.domainName,
  hostedZoneId: config.hostedZoneId,
  description: 'Lem Cloud Infrastructure - VPC, ECS, RDS, ALB, NLB, S3, CloudFront',
  tags: {
    Project: 'Lem',
    Environment: 'Production',
    ManagedBy: 'CDK',
  },
});

app.synth();
