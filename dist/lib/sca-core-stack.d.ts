import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
/**
 * ScaCoreStack - Core infrastructure for the Serverless Conversational Analytics solution
 *
 * CRITICAL DESIGN PRINCIPLE: NO CLOUDFORMATION EXPORTS
 * - This stack exposes resources via public readonly properties (vpc, alb, etc.)
 * - Resources are passed directly to dependent stacks via constructor props
 * - CloudFormation outputs do NOT use 'exportName' to avoid cross-stack dependencies
 * - Logical IDs are locked with overrideLogicalId() to prevent breaking changes
 *
 * See infrastructure/bin/sca-app.ts for how resources are passed between stacks.
 */
export declare class ScaCoreStack extends cdk.Stack {
    readonly vpc: ec2.Vpc;
    readonly alb: elbv2.ApplicationLoadBalancer;
    readonly transcriptionsTable: dynamodb.Table;
    readonly analyticsTable: dynamodb.Table;
    readonly transcriptionStream: kinesis.Stream;
    readonly deadLetterQueue: sqs.Queue;
    readonly cognitoUserPool: cognito.UserPool;
    readonly ecsCluster: ecs.Cluster;
    constructor(scope: Construct, id: string, props?: cdk.StackProps);
}
