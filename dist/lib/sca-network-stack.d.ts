import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
/**
 * ScaNetworkStack - Network infrastructure for the SCA solution
 *
 * This stack contains:
 * - VPC with private isolated subnets
 * - VPC endpoints for AWS services (S3, ECR, CloudWatch Logs, API Gateway)
 *
 * Resources are exposed via public readonly properties for use by other stacks.
 * NO CloudFormation exports are used to avoid cross-stack dependencies.
 */
export declare class ScaNetworkStack extends cdk.Stack {
    readonly vpc: ec2.Vpc;
    readonly apiGatewayVpcEndpoint: ec2.InterfaceVpcEndpoint;
    constructor(scope: Construct, id: string, props?: cdk.StackProps);
}
