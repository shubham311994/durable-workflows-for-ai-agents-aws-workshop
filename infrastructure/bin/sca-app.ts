#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ScaNetworkStack } from '../lib/sca-network-stack';
import { ScaBackendStack } from '../lib/sca-backend-stack';
import { ScaEcrStack } from '../lib/sca-ecr-stack';
import { ScaWebAppStack } from '../lib/sca-webapp-stack';
import { ScaCloudFrontAccessStack } from '../lib/sca-cloudfront-access-stack';
import { ScaConnectStack } from '../lib/sca-connect-stack';
import { ScaAiStack } from '../lib/sca-ai-stack';

const app = new cdk.App();

// Add CDK Nag checks for AWS Solutions best practices
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// 1. Network Stack - VPC, subnets, VPC endpoints (foundation)
const networkStack = new ScaNetworkStack(app, 'ScaNetworkStack', { env });

// 2. Backend Stack - Kinesis, Lambda, DynamoDB, API Gateway, Cognito
const backendStack = new ScaBackendStack(app, 'ScaBackendStack', {
  vpc: networkStack.vpc,
  apiGatewayVpcEndpoint: networkStack.apiGatewayVpcEndpoint,
  env,
});
backendStack.addDependency(networkStack);

// 3. ECR Stack - Container registry for web application
const ecrStack = new ScaEcrStack(app, 'ScaEcrStack', { env });

// 4. Web App Stack - ECS, ALB (requires ECR image to be pushed first)
const webAppStack = new ScaWebAppStack(app, 'ScaWebAppStack', {
  vpc: networkStack.vpc,
  cognitoUserPool: backendStack.cognitoUserPool,
  cognitoUserPoolClient: backendStack.cognitoUserPoolClient,
  dataRetrievalApi: backendStack.dataRetrievalApi,
  apiGatewayVpcEndpoint: networkStack.apiGatewayVpcEndpoint,
  ecrRepository: ecrStack.ecrRepository,
  env,
});
webAppStack.addDependency(networkStack);
webAppStack.addDependency(backendStack);
webAppStack.addDependency(ecrStack);

// Optional: CloudFront Access Stack (CloudFront, NAT Gateway, public subnets)
// Only deployed when explicitly enabled to prevent accidental public exposure
// Enable via context: cdk deploy ScaCloudFrontAccessStack -c enableCloudFrontAccess=true
const enableCloudFrontAccess = app.node.tryGetContext('enableCloudFrontAccess') === 'true';
if (enableCloudFrontAccess) {
  const cloudFrontAccessStack = new ScaCloudFrontAccessStack(app, 'ScaCloudFrontAccessStack', {
    vpc: networkStack.vpc,
    alb: webAppStack.alb,
    env,
  });
  cloudFrontAccessStack.addDependency(networkStack);
  cloudFrontAccessStack.addDependency(webAppStack);
}

// Optional: Connect + AI Integration Stacks
// Deploy with: cdk deploy ScaConnectStack ScaAiStack -c enableConnect=true
// ScaConnectStack creates the Connect instance and phone number.
// ScaAiStack creates the Lex bot, Wisdom assistant, orchestration AI agents,
// contact flow, and associates the phone number — no circular dependency.
const enableConnect = app.node.tryGetContext('enableConnect');
if (enableConnect === 'true') {
  // Connect Stack — instance, phone number, admin user, Contact Lens config
  const connectStack = new ScaConnectStack(app, 'ScaConnectStack', {
    transcriptionStreamName: 'sca-transcription-stream',
    env,
  });
  connectStack.addDependency(backendStack);

  // AI Stack — Lex bot, Wisdom assistant, orchestration AI agents, contact flow, phone number association
  const aiStack = new ScaAiStack(app, 'ScaAiStack', {
    connectInstanceArn: connectStack.connectInstance.attrArn,
    phoneNumberArn: connectStack.phoneNumber.attrPhoneNumberArn,
    // Scope the API Gateway invoke permission for the chat/voice Lambdas to the
    // backend data-retrieval API (which calls them via stage-variable integration).
    dataRetrievalApiId: backendStack.dataRetrievalApi.restApiId,
    env,
  });
  aiStack.addDependency(connectStack);
}
