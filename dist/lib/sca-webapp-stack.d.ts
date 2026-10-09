import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
export interface ScaWebAppStackProps extends cdk.StackProps {
    vpc: ec2.IVpc;
    cognitoUserPool: cognito.IUserPool;
    cognitoUserPoolClient: cognito.IUserPoolClient;
    dataRetrievalApi: apigateway.IRestApi;
    apiGatewayVpcEndpoint: ec2.IInterfaceVpcEndpoint;
    ecrRepository: ecr.IRepository;
}
/**
 * ScaWebAppStack - Web application infrastructure for the SCA solution
 *
 * This stack contains:
 * - ECS cluster and Fargate service
 * - Application Load Balancer (private)
 * - Auto-scaling configuration
 *
 * Prerequisites:
 * - ECR repository must exist (created by ScaEcrStack)
 * - Docker image must be pushed to ECR before deploying this stack
 *
 * Resources are exposed via public readonly properties for use by other stacks.
 * NO CloudFormation exports are used to avoid cross-stack dependencies.
 */
export declare class ScaWebAppStack extends cdk.Stack {
    readonly ecsCluster: ecs.Cluster;
    readonly alb: elbv2.ApplicationLoadBalancer;
    readonly albSecurityGroup: ec2.SecurityGroup;
    constructor(scope: Construct, id: string, props: ScaWebAppStackProps);
}
