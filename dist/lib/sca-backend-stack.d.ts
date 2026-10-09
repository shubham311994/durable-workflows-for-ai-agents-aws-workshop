import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
export interface ScaBackendStackProps extends cdk.StackProps {
    vpc: ec2.IVpc;
    apiGatewayVpcEndpoint: ec2.IInterfaceVpcEndpoint;
}
/**
 * ScaBackendStack - Backend services for the SCA solution
 *
 * This stack contains:
 * - Kinesis Stream for transcription ingestion
 * - DynamoDB tables for transcriptions and analytics
 * - Lambda functions for processing
 * - Private API Gateway for data retrieval
 * - Cognito User Pool for authentication
 * - SQS Dead Letter Queue
 *
 * Resources are exposed via public readonly properties for use by other stacks.
 * NO CloudFormation exports are used to avoid cross-stack dependencies.
 */
export declare class ScaBackendStack extends cdk.Stack {
    readonly transcriptionsTable: dynamodb.Table;
    readonly analyticsTable: dynamodb.Table;
    readonly transcriptionStream: kinesis.Stream;
    readonly deadLetterQueue: sqs.Queue;
    readonly cognitoUserPool: cognito.UserPool;
    readonly cognitoUserPoolClient: cognito.UserPoolClient;
    readonly dataRetrievalApi: apigateway.RestApi;
    constructor(scope: Construct, id: string, props: ScaBackendStackProps);
}
