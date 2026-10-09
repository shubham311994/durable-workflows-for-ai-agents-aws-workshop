import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
/**
 * ScaEcrStack - ECR repository for the SCA web application
 *
 * This stack contains:
 * - ECR repository for container images
 *
 * This stack is deployed first, before the web app stack, so that
 * we can build and push the Docker image before deploying ECS.
 *
 * Resources are exposed via public readonly properties for use by other stacks.
 * NO CloudFormation exports are used to avoid cross-stack dependencies.
 */
export declare class ScaEcrStack extends cdk.Stack {
    readonly ecrRepository: ecr.Repository;
    constructor(scope: Construct, id: string, props?: cdk.StackProps);
}
