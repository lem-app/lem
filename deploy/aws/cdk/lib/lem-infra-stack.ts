// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025 Lem

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface LemInfraStackProps extends cdk.StackProps {
  domainName: string;
  hostedZoneId: string;
}

export class LemInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LemInfraStackProps) {
    super(scope, id, props);

    const { domainName, hostedZoneId } = props;

    // ========================================
    // VPC and Networking
    // ========================================

    const vpc = new ec2.Vpc(this, 'LemVPC', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 1, // Use 2 for HA (higher cost)
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // ========================================
    // Route 53 Hosted Zone
    // ========================================

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId,
      zoneName: domainName,
    });

    // ========================================
    // ACM Certificates
    // ========================================

    // Certificate for signal.lem.gg (ALB)
    const signalCert = new acm.Certificate(this, 'SignalCertificate', {
      domainName: `signal.${domainName}`,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // Certificate for relay.lem.gg (NLB)
    const relayCert = new acm.Certificate(this, 'RelayCertificate', {
      domainName: `relay.${domainName}`,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // Certificate for app.lem.gg (CloudFront)
    // Must be in us-east-1 for CloudFront
    const appCert = new acm.Certificate(this, 'AppCertificate', {
      domainName: `app.${domainName}`,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // ========================================
    // Secrets Manager
    // ========================================

    // JWT Secret Key (shared between signaling and relay)
    const jwtSecret = new secretsmanager.Secret(this, 'JWTSecret', {
      secretName: 'lem/jwt/secret-key',
      description: 'JWT secret key for Lem services',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'lem' }),
        generateStringKey: 'SECRET_KEY',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    // Database credentials
    const dbCredentials = new secretsmanager.Secret(this, 'DBCredentials', {
      secretName: 'lem/db/credentials',
      description: 'PostgreSQL database credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'lemadmin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    // ========================================
    // RDS PostgreSQL Database
    // ========================================

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DBSecurityGroup', {
      vpc,
      description: 'Security group for RDS PostgreSQL',
      allowAllOutbound: true,
    });

    const database = new rds.DatabaseInstance(this, 'SignalingDB', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      databaseName: 'signaling',
      credentials: rds.Credentials.fromSecret(dbCredentials),
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageType: rds.StorageType.GP3,
      backupRetention: cdk.Duration.days(7),
      deleteAutomatedBackups: false,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      deletionProtection: true,
      multiAz: false, // Set to true for production HA
      publiclyAccessible: false,
      cloudwatchLogsExports: ['postgresql'],
    });

    // ========================================
    // ECR Repositories
    // ========================================

    const signalingRepo = new ecr.Repository(this, 'SignalingRepo', {
      repositoryName: 'lem-signaling',
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageCount: 10,
          description: 'Keep last 10 images',
        },
      ],
    });

    const relayRepo = new ecr.Repository(this, 'RelayRepo', {
      repositoryName: 'lem-relay',
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageCount: 10,
          description: 'Keep last 10 images',
        },
      ],
    });

    // ========================================
    // ECS Cluster
    // ========================================

    const cluster = new ecs.Cluster(this, 'LemCluster', {
      vpc,
      clusterName: 'lem-cluster',
      containerInsights: true,
    });

    // ========================================
    // Application Load Balancer (Signaling)
    // ========================================

    const albSecurityGroup = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
      vpc,
      description: 'Security group for signaling ALB',
      allowAllOutbound: true,
    });
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS');
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP');

    const alb = new elbv2.ApplicationLoadBalancer(this, 'SignalingALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const httpsListener = alb.addListener('HTTPSListener', {
      port: 443,
      certificates: [signalCert],
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not found',
      }),
    });

    // HTTP to HTTPS redirect
    alb.addListener('HTTPListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // ========================================
    // Network Load Balancer (Relay)
    // ========================================

    const nlb = new elbv2.NetworkLoadBalancer(this, 'RelayNLB', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // ========================================
    // ECS Task Definitions
    // ========================================

    // Signaling Server Task
    const signalingTaskDef = new ecs.FargateTaskDefinition(this, 'SignalingTaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Grant secrets access
    jwtSecret.grantRead(signalingTaskDef.taskRole);
    dbCredentials.grantRead(signalingTaskDef.taskRole);

    const signalingContainer = signalingTaskDef.addContainer('signaling', {
      image: ecs.ContainerImage.fromEcrRepository(signalingRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'lem-signaling',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
      environment: {
        HOST: '0.0.0.0',
        PORT: '8000',
        ALGORITHM: 'HS256',
        ACCESS_TOKEN_EXPIRE_MINUTES: '1440',
        CORS_ORIGINS: `https://app.${domainName}`,
        RELAY_URL: `wss://relay.${domainName}`,
      },
      secrets: {
        SECRET_KEY: ecs.Secret.fromSecretsManager(jwtSecret, 'SECRET_KEY'),
        DATABASE_URL: ecs.Secret.fromSecretsManager(dbCredentials),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'python -c "import urllib.request; urllib.request.urlopen(\'http://localhost:8000/health\').read()" || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(10),
      },
    });

    signalingContainer.addPortMappings({ containerPort: 8000 });

    // Relay Server Task
    const relayTaskDef = new ecs.FargateTaskDefinition(this, 'RelayTaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    jwtSecret.grantRead(relayTaskDef.taskRole);

    const relayContainer = relayTaskDef.addContainer('relay', {
      image: ecs.ContainerImage.fromEcrRepository(relayRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'lem-relay',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
      environment: {
        HOST: '0.0.0.0',
        PORT: '8001',
        ALGORITHM: 'HS256',
        CORS_ORIGINS: `https://app.${domainName}`,
        SESSION_TIMEOUT: '300',
        WS_PING_INTERVAL: '20',
        WS_PING_TIMEOUT: '10',
      },
      secrets: {
        SECRET_KEY: ecs.Secret.fromSecretsManager(jwtSecret, 'SECRET_KEY'),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'python -c "import urllib.request; urllib.request.urlopen(\'http://localhost:8001/health\').read()" || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(10),
      },
    });

    relayContainer.addPortMappings({ containerPort: 8001 });

    // ========================================
    // ECS Services
    // ========================================

    // Signaling Service
    const signalingService = new ecs.FargateService(this, 'SignalingService', {
      cluster,
      taskDefinition: signalingTaskDef,
      desiredCount: 2,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      circuitBreaker: { enable: true, rollback: true },
    });

    // Allow signaling to connect to database
    dbSecurityGroup.addIngressRule(
      signalingService.connections.securityGroups[0],
      ec2.Port.tcp(5432),
      'Allow from signaling service'
    );

    // Add signaling service to ALB target group
    const signalingTargetGroup = httpsListener.addTargets('SignalingTarget', {
      port: 8000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [signalingService],
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // Auto-scaling for signaling
    const signalingScaling = signalingService.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 10,
    });
    signalingScaling.scaleOnCpuUtilization('CPUScaling', {
      targetUtilizationPercent: 70,
    });
    signalingScaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 80,
    });

    // Relay Service
    const relayService = new ecs.FargateService(this, 'RelayService', {
      cluster,
      taskDefinition: relayTaskDef,
      desiredCount: 2,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      circuitBreaker: { enable: true, rollback: true },
    });

    // Add relay service to NLB with TLS listener
    const nlbListener = nlb.addListener('TLSListener', {
      port: 443,
      certificates: [relayCert],
    });

    nlbListener.addTargets('RelayTarget', {
      port: 8001,
      protocol: elbv2.Protocol.TCP,
      targets: [relayService],
      healthCheck: {
        protocol: elbv2.Protocol.HTTP,
        path: '/health',
        interval: cdk.Duration.seconds(30),
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // Auto-scaling for relay
    const relayScaling = relayService.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 10,
    });
    relayScaling.scaleOnCpuUtilization('CPUScaling', {
      targetUtilizationPercent: 70,
    });

    // ========================================
    // S3 + CloudFront (React App)
    // ========================================

    const appBucket = new s3.Bucket(this, 'AppBucket', {
      bucketName: `lem-app-${this.account}`,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const originAccessIdentity = new cloudfront.OriginAccessIdentity(this, 'OAI');
    appBucket.grantRead(originAccessIdentity);

    const distribution = new cloudfront.Distribution(this, 'AppDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(appBucket, {
          originAccessIdentity,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
      },
      domainNames: [`app.${domainName}`],
      certificate: appCert,
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
    });

    // ========================================
    // Route 53 Records
    // ========================================

    new route53.ARecord(this, 'SignalARecord', {
      zone: hostedZone,
      recordName: `signal.${domainName}`,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb)),
    });

    new route53.ARecord(this, 'RelayARecord', {
      zone: hostedZone,
      recordName: `relay.${domainName}`,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(nlb)),
    });

    new route53.ARecord(this, 'AppARecord', {
      zone: hostedZone,
      recordName: `app.${domainName}`,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    // ========================================
    // Outputs
    // ========================================

    new cdk.CfnOutput(this, 'SignalingALBURL', {
      value: `https://signal.${domainName}`,
      description: 'Signaling server URL',
    });

    new cdk.CfnOutput(this, 'RelayNLBURL', {
      value: `wss://relay.${domainName}`,
      description: 'Relay server URL',
    });

    new cdk.CfnOutput(this, 'AppURL', {
      value: `https://app.${domainName}`,
      description: 'React app URL',
    });

    new cdk.CfnOutput(this, 'AppBucketName', {
      value: appBucket.bucketName,
      description: 'S3 bucket for React app',
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionID', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID',
    });

    new cdk.CfnOutput(this, 'SignalingRepoURI', {
      value: signalingRepo.repositoryUri,
      description: 'ECR repository for signaling server',
    });

    new cdk.CfnOutput(this, 'RelayRepoURI', {
      value: relayRepo.repositoryUri,
      description: 'ECR repository for relay server',
    });
  }
}
