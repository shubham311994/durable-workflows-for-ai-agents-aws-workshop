"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScaCoreStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const kinesis = __importStar(require("aws-cdk-lib/aws-kinesis"));
const sqs = __importStar(require("aws-cdk-lib/aws-sqs"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const ecs = __importStar(require("aws-cdk-lib/aws-ecs"));
const elbv2 = __importStar(require("aws-cdk-lib/aws-elasticloadbalancingv2"));
const ecr = __importStar(require("aws-cdk-lib/aws-ecr"));
const cognito = __importStar(require("aws-cdk-lib/aws-cognito"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const lambdaEventSources = __importStar(require("aws-cdk-lib/aws-lambda-event-sources"));
const apigateway = __importStar(require("aws-cdk-lib/aws-apigateway"));
const path = __importStar(require("path"));
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
class ScaCoreStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Import ECR repository from ScaEcrStack
        // This repository must exist before deploying this stack
        const ecrRepository = ecr.Repository.fromRepositoryName(this, 'ImportedEcrRepository', 'sca-web-app');
        // VPC with only private subnets (public subnets added by CloudFront access stack if needed)
        this.vpc = new ec2.Vpc(this, 'ScaVpc', {
            maxAzs: 2,
            natGateways: 0, // No NAT Gateway needed without public subnets
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
        });
        // Override logical ID to ensure stable CloudFormation exports
        // This prevents breaking changes when code is reorganized
        this.vpc.node.defaultChild.overrideLogicalId('ScaVpcF197898D');
        // Kinesis Stream for transcription ingestion (using L2 construct with on-demand mode)
        this.transcriptionStream = new kinesis.Stream(this, 'TranscriptionStream', {
            streamName: 'sca-transcription-stream',
            streamMode: kinesis.StreamMode.ON_DEMAND,
            retentionPeriod: cdk.Duration.days(7),
        });
        // Dead Letter Queue for error handling
        this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
            queueName: 'sca-dead-letter-queue',
            retentionPeriod: cdk.Duration.days(14),
            visibilityTimeout: cdk.Duration.minutes(5),
        });
        // DynamoDB table for transcriptions with streams enabled
        this.transcriptionsTable = new dynamodb.Table(this, 'TranscriptionsTable', {
            tableName: 'sca-transcriptions',
            partitionKey: {
                name: 'PK',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'SK',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            pointInTimeRecovery: true,
            encryption: dynamodb.TableEncryption.DEFAULT,
            removalPolicy: cdk.RemovalPolicy.DESTROY, // For development
        });
        // Global Secondary Index for additional query patterns
        this.transcriptionsTable.addGlobalSecondaryIndex({
            indexName: 'GSI1',
            partitionKey: {
                name: 'GSI1PK',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'GSI1SK',
                type: dynamodb.AttributeType.STRING,
            },
        });
        // DynamoDB table for analytics and summaries
        this.analyticsTable = new dynamodb.Table(this, 'AnalyticsTable', {
            tableName: 'sca-analytics',
            partitionKey: {
                name: 'PK',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'SK',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecovery: true,
            encryption: dynamodb.TableEncryption.DEFAULT,
            removalPolicy: cdk.RemovalPolicy.DESTROY, // For development
        });
        // Transcription Processor Lambda Function
        // Dependencies are installed locally in the function directory
        const transcriptionProcessorFunction = new lambda.Function(this, 'TranscriptionProcessor', {
            functionName: 'sca-transcription-processor',
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'handler.lambda_handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/transcription-processor')),
            timeout: cdk.Duration.minutes(5),
            memorySize: 512,
            environment: {
                TRANSCRIPTIONS_TABLE: this.transcriptionsTable.tableName,
                DLQ_URL: this.deadLetterQueue.queueUrl,
                POWERTOOLS_SERVICE_NAME: 'transcription-processor',
                POWERTOOLS_METRICS_NAMESPACE: 'SCA',
                LOG_LEVEL: 'INFO',
            },
            tracing: lambda.Tracing.ACTIVE,
        });
        // Grant permissions to the Lambda function
        this.transcriptionsTable.grantReadWriteData(transcriptionProcessorFunction);
        this.deadLetterQueue.grantSendMessages(transcriptionProcessorFunction);
        // Add Kinesis event source to Lambda
        transcriptionProcessorFunction.addEventSource(new lambdaEventSources.KinesisEventSource(this.transcriptionStream, {
            startingPosition: lambda.StartingPosition.LATEST,
            batchSize: 100,
            maxBatchingWindow: cdk.Duration.seconds(10),
            retryAttempts: 3,
            bisectBatchOnError: true,
            reportBatchItemFailures: true,
        }));
        // Cognito User Pool for authentication
        this.cognitoUserPool = new cognito.UserPool(this, 'UserPool', {
            userPoolName: 'sca-user-pool',
            selfSignUpEnabled: true,
            signInAliases: {
                email: true,
            },
            autoVerify: {
                email: true,
            },
            passwordPolicy: {
                minLength: 8,
                requireLowercase: true,
                requireUppercase: true,
                requireDigits: true,
                requireSymbols: true,
            },
            accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
            removalPolicy: cdk.RemovalPolicy.DESTROY, // For development
        });
        // Cognito User Pool Client
        const userPoolClient = this.cognitoUserPool.addClient('WebAppClient', {
            userPoolClientName: 'sca-web-app-client',
            generateSecret: false,
            authFlows: {
                userSrp: true,
                userPassword: true,
            },
            oAuth: {
                flows: {
                    authorizationCodeGrant: true,
                },
                scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
            },
        });
        // Cognito User Group for analysts
        const analystGroup = new cognito.CfnUserPoolGroup(this, 'AnalystGroup', {
            userPoolId: this.cognitoUserPool.userPoolId,
            groupName: 'Analysts',
            description: 'Contact center analysts who can view and analyze conversations',
            precedence: 1,
        });
        // Cognito User Group for administrators
        const adminGroup = new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
            userPoolId: this.cognitoUserPool.userPoolId,
            groupName: 'Administrators',
            description: 'System administrators with full access',
            precedence: 0,
        });
        // Users can be created via the setup-test-user.sh script
        // Usage: ./scripts/setup-test-user.sh <email> [group-name]
        // ========================================
        // AppSync Events API Setup - REMOVED
        // ========================================
        // AppSync Events cannot be accessed privately without VPC endpoint support
        // Switched to polling-based approach for real-time updates
        // ========================================
        // Analytics Processor Lambda Function
        // ========================================
        // Triggered by DynamoDB Streams from Transcriptions table
        const analyticsProcessorFunction = new lambda.Function(this, 'AnalyticsProcessor', {
            functionName: 'sca-analytics-processor',
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'handler.lambda_handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/analytics-processor')),
            timeout: cdk.Duration.minutes(5),
            memorySize: 1024, // Higher memory for Bedrock API calls
            environment: {
                TRANSCRIPTIONS_TABLE: this.transcriptionsTable.tableName,
                ANALYTICS_TABLE: this.analyticsTable.tableName,
                POWERTOOLS_SERVICE_NAME: 'analytics-processor',
                POWERTOOLS_METRICS_NAMESPACE: 'SCA',
                LOG_LEVEL: 'INFO',
            },
            tracing: lambda.Tracing.ACTIVE,
        });
        // Grant permissions to the Analytics Processor Lambda
        this.transcriptionsTable.grantReadData(analyticsProcessorFunction);
        this.analyticsTable.grantReadWriteData(analyticsProcessorFunction);
        // Grant Bedrock permissions for AI analytics
        analyticsProcessorFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream',
            ],
            resources: [
                `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
            ],
        }));
        // Add DynamoDB Streams event source to Analytics Processor Lambda
        analyticsProcessorFunction.addEventSource(new lambdaEventSources.DynamoEventSource(this.transcriptionsTable, {
            startingPosition: lambda.StartingPosition.LATEST,
            batchSize: 10,
            maxBatchingWindow: cdk.Duration.seconds(5),
            retryAttempts: 3,
            bisectBatchOnError: true,
            reportBatchItemFailures: true,
            filters: [
                // Only process INSERT and MODIFY events
                lambda.FilterCriteria.filter({
                    eventName: lambda.FilterRule.isEqual('INSERT'),
                }),
                lambda.FilterCriteria.filter({
                    eventName: lambda.FilterRule.isEqual('MODIFY'),
                }),
            ],
        }));
        // ========================================
        // Data Retrieval Lambda Function
        // ========================================
        // Provides REST API for querying transcriptions and analytics
        const dataRetrievalFunction = new lambda.Function(this, 'DataRetrieval', {
            functionName: 'sca-data-retrieval',
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'handler.lambda_handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/data-retrieval')),
            timeout: cdk.Duration.seconds(30),
            memorySize: 512,
            environment: {
                TRANSCRIPTIONS_TABLE: this.transcriptionsTable.tableName,
                ANALYTICS_TABLE: this.analyticsTable.tableName,
                POWERTOOLS_SERVICE_NAME: 'data-retrieval',
                POWERTOOLS_METRICS_NAMESPACE: 'SCA',
                LOG_LEVEL: 'INFO',
            },
            tracing: lambda.Tracing.ACTIVE,
        });
        // Grant read permissions to the Data Retrieval Lambda
        this.transcriptionsTable.grantReadData(dataRetrievalFunction);
        this.analyticsTable.grantReadData(dataRetrievalFunction);
        // ========================================
        // VPC Endpoints for Private Connectivity
        // ========================================
        // S3 Gateway Endpoint (for ECR image layers - no hourly charge)
        this.vpc.addGatewayEndpoint('S3GatewayEndpoint', {
            service: ec2.GatewayVpcEndpointAwsService.S3,
            subnets: [
                {
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
        });
        // ECR API Endpoint (for ECS to authenticate and get image manifests)
        new ec2.InterfaceVpcEndpoint(this, 'EcrApiVpcEndpoint', {
            vpc: this.vpc,
            service: ec2.InterfaceVpcEndpointAwsService.ECR,
            privateDnsEnabled: true,
            subnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
        });
        // ECR Docker Endpoint (for ECS to pull Docker images)
        new ec2.InterfaceVpcEndpoint(this, 'EcrDkrVpcEndpoint', {
            vpc: this.vpc,
            service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
            privateDnsEnabled: true,
            subnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
        });
        // CloudWatch Logs Endpoint (for ECS container logging)
        new ec2.InterfaceVpcEndpoint(this, 'CloudWatchLogsVpcEndpoint', {
            vpc: this.vpc,
            service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
            privateDnsEnabled: true,
            subnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
        });
        // ========================================
        // Private API Gateway for Data Retrieval
        // ========================================
        // Create VPC Endpoint for API Gateway (required for private API)
        const apiGatewayVpcEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ApiGatewayVpcEndpoint', {
            vpc: this.vpc,
            service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
            privateDnsEnabled: true,
            subnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
        });
        // Create private REST API
        const dataRetrievalApi = new apigateway.RestApi(this, 'DataRetrievalApi', {
            restApiName: 'sca-data-retrieval-api',
            description: 'Private API for querying contact transcriptions and analytics',
            endpointConfiguration: {
                types: [apigateway.EndpointType.PRIVATE],
                vpcEndpoints: [apiGatewayVpcEndpoint],
            },
            policy: new iam.PolicyDocument({
                statements: [
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        principals: [new iam.AnyPrincipal()],
                        actions: ['execute-api:Invoke'],
                        resources: ['execute-api:/*'],
                        conditions: {
                            StringEquals: {
                                'aws:SourceVpce': apiGatewayVpcEndpoint.vpcEndpointId,
                            },
                        },
                    }),
                ],
            }),
            deployOptions: {
                stageName: 'prod',
                tracingEnabled: true,
                loggingLevel: apigateway.MethodLoggingLevel.INFO,
                dataTraceEnabled: true,
                metricsEnabled: true,
            },
        });
        // Add Lambda integration
        const dataRetrievalIntegration = new apigateway.LambdaIntegration(dataRetrievalFunction, {
            proxy: true,
        });
        // Add API Gateway routes
        dataRetrievalApi.root.addMethod('ANY', dataRetrievalIntegration);
        dataRetrievalApi.root.addProxy({
            defaultIntegration: dataRetrievalIntegration,
            anyMethod: true,
        });
        // ECS Cluster in private subnets
        this.ecsCluster = new ecs.Cluster(this, 'EcsCluster', {
            clusterName: 'sca-cluster',
            vpc: this.vpc,
            containerInsights: true,
        });
        // Security group for ALB
        const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
            vpc: this.vpc,
            description: 'Security group for SCA Application Load Balancer',
            allowAllOutbound: true,
        });
        // Optional: Allow inbound traffic from specific CIDR blocks (only if explicitly configured)
        const allowedCidrBlocks = this.node.tryGetContext('allowedCidrBlocks');
        if (allowedCidrBlocks && Array.isArray(allowedCidrBlocks)) {
            allowedCidrBlocks.forEach((cidr) => {
                albSecurityGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(80), `Allow HTTP from ${cidr}`);
                albSecurityGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(443), `Allow HTTPS from ${cidr}`);
            });
        }
        // Private Application Load Balancer (in isolated subnets)
        this.alb = new elbv2.ApplicationLoadBalancer(this, 'PrivateAlb', {
            vpc: this.vpc,
            internetFacing: false,
            securityGroup: albSecurityGroup,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
        });
        // Override logical ID to ensure stable CloudFormation exports
        // This prevents breaking changes when code is reorganized
        this.alb.node.defaultChild.overrideLogicalId('PrivateAlbF07A94D5');
        // Security group for ECS tasks
        const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
            vpc: this.vpc,
            description: 'Security group for SCA ECS tasks',
            allowAllOutbound: true,
        });
        // Allow ALB to communicate with ECS tasks
        ecsSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(3000), 'Allow ALB to reach ECS tasks');
        // ========================================
        // ECS Task Definition and Service
        // ========================================
        // IAM role for ECS task execution (pull images, write logs)
        const taskExecutionRole = new iam.Role(this, 'EcsTaskExecutionRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
            ],
        });
        // Grant ECR pull permissions
        ecrRepository.grantPull(taskExecutionRole);
        // IAM role for ECS task (application permissions)
        const taskRole = new iam.Role(this, 'EcsTaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });
        // ECS Task Definition
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'WebAppTaskDefinition', {
            family: 'sca-web-app',
            cpu: 256,
            memoryLimitMiB: 512,
            executionRole: taskExecutionRole,
            taskRole: taskRole,
        });
        // Add container to task definition
        const container = taskDefinition.addContainer('WebAppContainer', {
            containerName: 'sca-web-app',
            image: ecs.ContainerImage.fromEcrRepository(ecrRepository, 'latest'),
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'sca-web-app',
                logRetention: 7, // 7 days retention
            }),
            environment: {
                // React build-time environment variables (embedded in JS bundle)
                REACT_APP_USER_POOL_ID: this.cognitoUserPool.userPoolId,
                REACT_APP_USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
                REACT_APP_API_ENDPOINT: dataRetrievalApi.url, // Keep for backwards compatibility
                REACT_APP_AWS_REGION: this.region,
                // Nginx runtime environment variable for API proxy - MUST use VPC endpoint format
                API_ENDPOINT: `https://${dataRetrievalApi.restApiId}-${apiGatewayVpcEndpoint.vpcEndpointId}.execute-api.${this.region}.amazonaws.com/prod/`,
            },
            healthCheck: {
                command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5),
                retries: 3,
                startPeriod: cdk.Duration.seconds(60),
            },
        });
        // Add port mapping
        container.addPortMappings({
            containerPort: 3000,
            protocol: ecs.Protocol.TCP,
        });
        // ECS Service
        const ecsService = new ecs.FargateService(this, 'WebAppService', {
            serviceName: 'sca-web-app-service',
            cluster: this.ecsCluster,
            taskDefinition: taskDefinition,
            desiredCount: 2, // Run 2 tasks for high availability
            minHealthyPercent: 50,
            maxHealthyPercent: 200,
            securityGroups: [ecsSecurityGroup],
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
            enableExecuteCommand: true, // Enable ECS Exec for debugging
            circuitBreaker: {
                rollback: true, // Automatic rollback on deployment failure
            },
        });
        // ALB Target Group for ECS Service
        const targetGroup = new elbv2.ApplicationTargetGroup(this, 'WebAppTargetGroup', {
            vpc: this.vpc,
            port: 3000,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                path: '/health',
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3,
                healthyHttpCodes: '200',
            },
            deregistrationDelay: cdk.Duration.seconds(30),
        });
        // Register ECS service with target group
        ecsService.attachToApplicationTargetGroup(targetGroup);
        // ALB Listener (HTTP on port 80)
        // Note: open: false prevents CDK from automatically adding 0.0.0.0/0 ingress rule
        const listener = this.alb.addListener('HttpListener', {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.forward([targetGroup]),
            open: false, // Don't automatically add 0.0.0.0/0 ingress rule
        });
        // Auto-scaling configuration
        const scaling = ecsService.autoScaleTaskCount({
            minCapacity: 2,
            maxCapacity: 10,
        });
        // Scale based on CPU utilization
        scaling.scaleOnCpuUtilization('CpuScaling', {
            targetUtilizationPercent: 70,
            scaleInCooldown: cdk.Duration.seconds(60),
            scaleOutCooldown: cdk.Duration.seconds(60),
        });
        // Scale based on memory utilization
        scaling.scaleOnMemoryUtilization('MemoryScaling', {
            targetUtilizationPercent: 80,
            scaleInCooldown: cdk.Duration.seconds(60),
            scaleOutCooldown: cdk.Duration.seconds(60),
        });
        // ========================================
        // CloudFormation Outputs
        // ========================================
        // CRITICAL: DO NOT add 'exportName' to any outputs!
        // Exports create cross-stack dependencies that prevent stack updates.
        // Resources should be passed directly via stack props instead.
        // See: infrastructure/bin/sca-app.ts for how resources are passed between stacks
        new cdk.CfnOutput(this, 'VpcId', {
            value: this.vpc.vpcId,
            description: 'VPC ID for the SCA solution',
        });
        new cdk.CfnOutput(this, 'TranscriptionStreamName', {
            value: this.transcriptionStream.streamName,
            description: 'Kinesis Stream name for transcription ingestion',
        });
        new cdk.CfnOutput(this, 'TranscriptionStreamArn', {
            value: this.transcriptionStream.streamArn,
            description: 'Kinesis Stream ARN for transcription ingestion',
        });
        new cdk.CfnOutput(this, 'TranscriptionsTableName', {
            value: this.transcriptionsTable.tableName,
            description: 'DynamoDB table name for transcriptions',
        });
        new cdk.CfnOutput(this, 'AnalyticsTableName', {
            value: this.analyticsTable.tableName,
            description: 'DynamoDB table name for analytics',
        });
        new cdk.CfnOutput(this, 'DeadLetterQueueUrl', {
            value: this.deadLetterQueue.queueUrl,
            description: 'SQS Dead Letter Queue URL',
        });
        new cdk.CfnOutput(this, 'EcrRepositoryUri', {
            value: ecrRepository.repositoryUri,
            description: 'ECR repository URI for web application images (imported from ScaEcrStack)',
        });
        new cdk.CfnOutput(this, 'UserPoolId', {
            value: this.cognitoUserPool.userPoolId,
            description: 'Cognito User Pool ID',
        });
        new cdk.CfnOutput(this, 'UserPoolClientId', {
            value: userPoolClient.userPoolClientId,
            description: 'Cognito User Pool Client ID',
        });
        new cdk.CfnOutput(this, 'AlbDnsName', {
            value: this.alb.loadBalancerDnsName,
            description: 'Private ALB DNS name',
        });
        new cdk.CfnOutput(this, 'EcsClusterName', {
            value: this.ecsCluster.clusterName,
            description: 'ECS Cluster name',
        });
        new cdk.CfnOutput(this, 'TranscriptionProcessorFunctionName', {
            value: transcriptionProcessorFunction.functionName,
            description: 'Transcription Processor Lambda function name',
        });
        new cdk.CfnOutput(this, 'TranscriptionProcessorFunctionArn', {
            value: transcriptionProcessorFunction.functionArn,
            description: 'Transcription Processor Lambda function ARN',
        });
        new cdk.CfnOutput(this, 'AnalyticsProcessorFunctionName', {
            value: analyticsProcessorFunction.functionName,
            description: 'Analytics Processor Lambda function name',
        });
        new cdk.CfnOutput(this, 'AnalyticsProcessorFunctionArn', {
            value: analyticsProcessorFunction.functionArn,
            description: 'Analytics Processor Lambda function ARN',
        });
        new cdk.CfnOutput(this, 'DataRetrievalFunctionName', {
            value: dataRetrievalFunction.functionName,
            description: 'Data Retrieval Lambda function name',
        });
        new cdk.CfnOutput(this, 'DataRetrievalFunctionArn', {
            value: dataRetrievalFunction.functionArn,
            description: 'Data Retrieval Lambda function ARN',
        });
        new cdk.CfnOutput(this, 'DataRetrievalApiId', {
            value: dataRetrievalApi.restApiId,
            description: 'Private API Gateway ID for data retrieval',
        });
        new cdk.CfnOutput(this, 'DataRetrievalApiEndpoint', {
            value: dataRetrievalApi.url,
            description: 'Private API Gateway endpoint for data retrieval (standard format)',
        });
        new cdk.CfnOutput(this, 'DataRetrievalApiVpcEndpoint', {
            value: `https://${dataRetrievalApi.restApiId}-${apiGatewayVpcEndpoint.vpcEndpointId}.execute-api.${this.region}.amazonaws.com/prod/`,
            description: 'Private API Gateway endpoint with VPC endpoint ID (use this for nginx proxy)',
        });
        new cdk.CfnOutput(this, 'ApiGatewayVpcEndpointId', {
            value: apiGatewayVpcEndpoint.vpcEndpointId,
            description: 'VPC Endpoint ID for API Gateway',
        });
        new cdk.CfnOutput(this, 'AnalystGroupName', {
            value: analystGroup.groupName,
            description: 'Cognito User Group for analysts',
        });
        new cdk.CfnOutput(this, 'AdminGroupName', {
            value: adminGroup.groupName,
            description: 'Cognito User Group for administrators',
        });
        new cdk.CfnOutput(this, 'CreateUserCommand', {
            value: `./scripts/setup-test-user.sh <email> Analysts`,
            description: 'Command to create a new Cognito user with temporary password sent via email',
        });
    }
}
exports.ScaCoreStack = ScaCoreStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NhLWNvcmUtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9pbmZyYXN0cnVjdHVyZS9saWIvc2NhLWNvcmUtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLG1FQUFxRDtBQUNyRCxpRUFBbUQ7QUFDbkQseURBQTJDO0FBQzNDLHlEQUEyQztBQUMzQyx5REFBMkM7QUFDM0MsOEVBQWdFO0FBQ2hFLHlEQUEyQztBQUMzQyxpRUFBbUQ7QUFDbkQseURBQTJDO0FBQzNDLCtEQUFpRDtBQUNqRCx5RkFBMkU7QUFDM0UsdUVBQXlEO0FBRXpELDJDQUE2QjtBQUU3Qjs7Ozs7Ozs7OztHQVVHO0FBQ0gsTUFBYSxZQUFhLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFVekMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUM5RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4Qix5Q0FBeUM7UUFDekMseURBQXlEO1FBQ3pELE1BQU0sYUFBYSxHQUFHLEdBQUcsQ0FBQyxVQUFVLENBQUMsa0JBQWtCLENBQ3JELElBQUksRUFDSix1QkFBdUIsRUFDdkIsYUFBYSxDQUNkLENBQUM7UUFFRiw0RkFBNEY7UUFDNUYsSUFBSSxDQUFDLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLFFBQVEsRUFBRTtZQUNyQyxNQUFNLEVBQUUsQ0FBQztZQUNULFdBQVcsRUFBRSxDQUFDLEVBQUUsK0NBQStDO1lBQy9ELG1CQUFtQixFQUFFO2dCQUNuQjtvQkFDRSxRQUFRLEVBQUUsRUFBRTtvQkFDWixJQUFJLEVBQUUsU0FBUztvQkFDZixVQUFVLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxnQkFBZ0I7aUJBQzVDO2FBQ0Y7U0FDRixDQUFDLENBQUM7UUFFSCw4REFBOEQ7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QUFDLGFBQWEsZ0JBQWdCLElBQUksQ0FBQyxNQUFNLHNCQUFzQjtZQUNwSSxXQUFXLEVBQUUsOEVBQThFO1NBQzVGLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUseUJBQXlCLEVBQUU7WUFDakQsS0FBSyxFQUFFLHFCQUFxQixDQUFDLGFBQWE7WUFDMUMsV0FBVyxFQUFFLGlDQUFpQztTQUMvQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGtCQUFrQixFQUFFO1lBQzFDLEtBQUssRUFBRSxZQUFZLENBQUMsU0FBVTtZQUM5QixXQUFXLEVBQUUsaUNBQWlDO1NBQy9DLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLEVBQUU7WUFDeEMsS0FBSyxFQUFFLFVBQVUsQ0FBQyxTQUFVO1lBQzVCLFdBQVcsRUFBRSx1Q0FBdUM7U0FDckQsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxtQkFBbUIsRUFBRTtZQUMzQyxLQUFLLEVBQUUsK0NBQStDO1lBQ3RELFdBQVcsRUFBRSw2RUFBNkU7U0FDM0YsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBMXJCRCxvQ0EwckJDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gJ2F3cy1jZGstbGliL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgKiBhcyBraW5lc2lzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1raW5lc2lzJztcbmltcG9ydCAqIGFzIHNxcyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc3FzJztcbmltcG9ydCAqIGFzIGVjMiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWMyJztcbmltcG9ydCAqIGFzIGVjcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNzJztcbmltcG9ydCAqIGFzIGVsYnYyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljbG9hZGJhbGFuY2luZ3YyJztcbmltcG9ydCAqIGFzIGVjciBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNyJztcbmltcG9ydCAqIGFzIGNvZ25pdG8gZnJvbSAnYXdzLWNkay1saWIvYXdzLWNvZ25pdG8nO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgbGFtYmRhRXZlbnRTb3VyY2VzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEtZXZlbnQtc291cmNlcyc7XG5pbXBvcnQgKiBhcyBhcGlnYXRld2F5IGZyb20gJ2F3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5JztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcblxuLyoqXG4gKiBTY2FDb3JlU3RhY2sgLSBDb3JlIGluZnJhc3RydWN0dXJlIGZvciB0aGUgU2VydmVybGVzcyBDb252ZXJzYXRpb25hbCBBbmFseXRpY3Mgc29sdXRpb25cbiAqIFxuICogQ1JJVElDQUwgREVTSUdOIFBSSU5DSVBMRTogTk8gQ0xPVURGT1JNQVRJT04gRVhQT1JUU1xuICogLSBUaGlzIHN0YWNrIGV4cG9zZXMgcmVzb3VyY2VzIHZpYSBwdWJsaWMgcmVhZG9ubHkgcHJvcGVydGllcyAodnBjLCBhbGIsIGV0Yy4pXG4gKiAtIFJlc291cmNlcyBhcmUgcGFzc2VkIGRpcmVjdGx5IHRvIGRlcGVuZGVudCBzdGFja3MgdmlhIGNvbnN0cnVjdG9yIHByb3BzXG4gKiAtIENsb3VkRm9ybWF0aW9uIG91dHB1dHMgZG8gTk9UIHVzZSAnZXhwb3J0TmFtZScgdG8gYXZvaWQgY3Jvc3Mtc3RhY2sgZGVwZW5kZW5jaWVzXG4gKiAtIExvZ2ljYWwgSURzIGFyZSBsb2NrZWQgd2l0aCBvdmVycmlkZUxvZ2ljYWxJZCgpIHRvIHByZXZlbnQgYnJlYWtpbmcgY2hhbmdlc1xuICogXG4gKiBTZWUgaW5mcmFzdHJ1Y3R1cmUvYmluL3NjYS1hcHAudHMgZm9yIGhvdyByZXNvdXJjZXMgYXJlIHBhc3NlZCBiZXR3ZWVuIHN0YWNrcy5cbiAqL1xuZXhwb3J0IGNsYXNzIFNjYUNvcmVTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSB2cGM6IGVjMi5WcGM7XG4gIHB1YmxpYyByZWFkb25seSBhbGI6IGVsYnYyLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyO1xuICBwdWJsaWMgcmVhZG9ubHkgdHJhbnNjcmlwdGlvbnNUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBhbmFseXRpY3NUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSB0cmFuc2NyaXB0aW9uU3RyZWFtOiBraW5lc2lzLlN0cmVhbTtcbiAgcHVibGljIHJlYWRvbmx5IGRlYWRMZXR0ZXJRdWV1ZTogc3FzLlF1ZXVlO1xuICBwdWJsaWMgcmVhZG9ubHkgY29nbml0b1VzZXJQb29sOiBjb2duaXRvLlVzZXJQb29sO1xuICBwdWJsaWMgcmVhZG9ubHkgZWNzQ2x1c3RlcjogZWNzLkNsdXN0ZXI7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gSW1wb3J0IEVDUiByZXBvc2l0b3J5IGZyb20gU2NhRWNyU3RhY2tcbiAgICAvLyBUaGlzIHJlcG9zaXRvcnkgbXVzdCBleGlzdCBiZWZvcmUgZGVwbG95aW5nIHRoaXMgc3RhY2tcbiAgICBjb25zdCBlY3JSZXBvc2l0b3J5ID0gZWNyLlJlcG9zaXRvcnkuZnJvbVJlcG9zaXRvcnlOYW1lKFxuICAgICAgdGhpcyxcbiAgICAgICdJbXBvcnRlZEVjclJlcG9zaXRvcnknLFxuICAgICAgJ3NjYS13ZWItYXBwJ1xuICAgICk7XG5cbiAgICAvLyBWUEMgd2l0aCBvbmx5IHByaXZhdGUgc3VibmV0cyAocHVibGljIHN1Ym5ldHMgYWRkZWQgYnkgQ2xvdWRGcm9udCBhY2Nlc3Mgc3RhY2sgaWYgbmVlZGVkKVxuICAgIHRoaXMudnBjID0gbmV3IGVjMi5WcGModGhpcywgJ1NjYVZwYycsIHtcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAwLCAvLyBObyBOQVQgR2F0ZXdheSBuZWVkZWQgd2l0aG91dCBwdWJsaWMgc3VibmV0c1xuICAgICAgc3VibmV0Q29uZmlndXJhdGlvbjogW1xuICAgICAgICB7XG4gICAgICAgICAgY2lkck1hc2s6IDI0LFxuICAgICAgICAgIG5hbWU6ICdQcml2YXRlJyxcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX0lTT0xBVEVELFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcbiAgICBcbiAgICAvLyBPdmVycmlkZSBsb2dpY2FsIElEIHRvIGVuc3VyZSBzdGFibGUgQ2xvdWRGb3JtYXRpb24gZXhwb3J0c1xuICAgIC8vIFRoaXMgcHJldmVudHMgYnJlYWtpbmcgY2hhbmdlcyB3aGVuIGNvZGUgaXMgcmVvcmdhbml6ZWRcbiAgICAodGhpcy52cGMubm9kZS5kZWZhdWx0Q2hpbGQgYXMgZWMyLkNmblZQQykub3ZlcnJpZGVMb2dpY2FsSWQoJ1NjYVZwY0YxOTc4OThEJyk7XG5cbiAgICAvLyBLaW5lc2lzIFN0cmVhbSBmb3IgdHJhbnNjcmlwdGlvbiBpbmdlc3Rpb24gKHVzaW5nIEwyIGNvbnN0cnVjdCB3aXRoIG9uLWRlbWFuZCBtb2RlKVxuICAgIHRoaXMudHJhbnNjcmlwdGlvblN0cmVhbSA9IG5ldyBraW5lc2lzLlN0cmVhbSh0aGlzLCAnVHJhbnNjcmlwdGlvblN0cmVhbScsIHtcbiAgICAgIHN0cmVhbU5hbWU6ICdzY2EtdHJhbnNjcmlwdGlvbi1zdHJlYW0nLFxuICAgICAgc3RyZWFtTW9kZToga2luZXNpcy5TdHJlYW1Nb2RlLk9OX0RFTUFORCxcbiAgICAgIHJldGVudGlvblBlcmlvZDogY2RrLkR1cmF0aW9uLmRheXMoNyksXG4gICAgfSk7XG5cbiAgICAvLyBEZWFkIExldHRlciBRdWV1ZSBmb3IgZXJyb3IgaGFuZGxpbmdcbiAgICB0aGlzLmRlYWRMZXR0ZXJRdWV1ZSA9IG5ldyBzcXMuUXVldWUodGhpcywgJ0RlYWRMZXR0ZXJRdWV1ZScsIHtcbiAgICAgIHF1ZXVlTmFtZTogJ3NjYS1kZWFkLWxldHRlci1xdWV1ZScsXG4gICAgICByZXRlbnRpb25QZXJpb2Q6IGNkay5EdXJhdGlvbi5kYXlzKDE0KSxcbiAgICAgIHZpc2liaWxpdHlUaW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcyg1KSxcbiAgICB9KTtcblxuICAgIC8vIER5bmFtb0RCIHRhYmxlIGZvciB0cmFuc2NyaXB0aW9ucyB3aXRoIHN0cmVhbXMgZW5hYmxlZFxuICAgIHRoaXMudHJhbnNjcmlwdGlvbnNUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCAnVHJhbnNjcmlwdGlvbnNUYWJsZScsIHtcbiAgICAgIHRhYmxlTmFtZTogJ3NjYS10cmFuc2NyaXB0aW9ucycsXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ1BLJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnU0snLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgc3RyZWFtOiBkeW5hbW9kYi5TdHJlYW1WaWV3VHlwZS5ORVdfQU5EX09MRF9JTUFHRVMsXG4gICAgICBwb2ludEluVGltZVJlY292ZXJ5OiB0cnVlLFxuICAgICAgZW5jcnlwdGlvbjogZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkRFRkFVTFQsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLCAvLyBGb3IgZGV2ZWxvcG1lbnRcbiAgICB9KTtcblxuICAgIC8vIEdsb2JhbCBTZWNvbmRhcnkgSW5kZXggZm9yIGFkZGl0aW9uYWwgcXVlcnkgcGF0dGVybnNcbiAgICB0aGlzLnRyYW5zY3JpcHRpb25zVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiAnR1NJMScsXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ0dTSTFQSycsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgbmFtZTogJ0dTSTFTSycsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIER5bmFtb0RCIHRhYmxlIGZvciBhbmFseXRpY3MgYW5kIHN1bW1hcmllc1xuICAgIHRoaXMuYW5hbHl0aWNzVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ0FuYWx5dGljc1RhYmxlJywge1xuICAgICAgdGFibGVOYW1lOiAnc2NhLWFuYWx5dGljcycsXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ1BLJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnU0snLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeTogdHJ1ZSxcbiAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5ERUZBVUxULFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSwgLy8gRm9yIGRldmVsb3BtZW50XG4gICAgfSk7XG5cbiAgICAvLyBUcmFuc2NyaXB0aW9uIFByb2Nlc3NvciBMYW1iZGEgRnVuY3Rpb25cbiAgICAvLyBEZXBlbmRlbmNpZXMgYXJlIGluc3RhbGxlZCBsb2NhbGx5IGluIHRoZSBmdW5jdGlvbiBkaXJlY3RvcnlcbiAgICBjb25zdCB0cmFuc2NyaXB0aW9uUHJvY2Vzc29yRnVuY3Rpb24gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdUcmFuc2NyaXB0aW9uUHJvY2Vzc29yJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc2NhLXRyYW5zY3JpcHRpb24tcHJvY2Vzc29yJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzEzLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXIubGFtYmRhX2hhbmRsZXInLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi8uLi9iYWNrZW5kL3RyYW5zY3JpcHRpb24tcHJvY2Vzc29yJykpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICBtZW1vcnlTaXplOiA1MTIsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBUUkFOU0NSSVBUSU9OU19UQUJMRTogdGhpcy50cmFuc2NyaXB0aW9uc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgRExRX1VSTDogdGhpcy5kZWFkTGV0dGVyUXVldWUucXVldWVVcmwsXG4gICAgICAgIFBPV0VSVE9PTFNfU0VSVklDRV9OQU1FOiAndHJhbnNjcmlwdGlvbi1wcm9jZXNzb3InLFxuICAgICAgICBQT1dFUlRPT0xTX01FVFJJQ1NfTkFNRVNQQUNFOiAnU0NBJyxcbiAgICAgICAgTE9HX0xFVkVMOiAnSU5GTycsXG4gICAgICB9LFxuICAgICAgdHJhY2luZzogbGFtYmRhLlRyYWNpbmcuQUNUSVZFLFxuICAgIH0pO1xuXG4gICAgLy8gR3JhbnQgcGVybWlzc2lvbnMgdG8gdGhlIExhbWJkYSBmdW5jdGlvblxuICAgIHRoaXMudHJhbnNjcmlwdGlvbnNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEodHJhbnNjcmlwdGlvblByb2Nlc3NvckZ1bmN0aW9uKTtcbiAgICB0aGlzLmRlYWRMZXR0ZXJRdWV1ZS5ncmFudFNlbmRNZXNzYWdlcyh0cmFuc2NyaXB0aW9uUHJvY2Vzc29yRnVuY3Rpb24pO1xuXG4gICAgLy8gQWRkIEtpbmVzaXMgZXZlbnQgc291cmNlIHRvIExhbWJkYVxuICAgIHRyYW5zY3JpcHRpb25Qcm9jZXNzb3JGdW5jdGlvbi5hZGRFdmVudFNvdXJjZShcbiAgICAgIG5ldyBsYW1iZGFFdmVudFNvdXJjZXMuS2luZXNpc0V2ZW50U291cmNlKHRoaXMudHJhbnNjcmlwdGlvblN0cmVhbSwge1xuICAgICAgICBzdGFydGluZ1Bvc2l0aW9uOiBsYW1iZGEuU3RhcnRpbmdQb3NpdGlvbi5MQVRFU1QsXG4gICAgICAgIGJhdGNoU2l6ZTogMTAwLFxuICAgICAgICBtYXhCYXRjaGluZ1dpbmRvdzogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgICAgICByZXRyeUF0dGVtcHRzOiAzLFxuICAgICAgICBiaXNlY3RCYXRjaE9uRXJyb3I6IHRydWUsXG4gICAgICAgIHJlcG9ydEJhdGNoSXRlbUZhaWx1cmVzOiB0cnVlLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gQ29nbml0byBVc2VyIFBvb2wgZm9yIGF1dGhlbnRpY2F0aW9uXG4gICAgdGhpcy5jb2duaXRvVXNlclBvb2wgPSBuZXcgY29nbml0by5Vc2VyUG9vbCh0aGlzLCAnVXNlclBvb2wnLCB7XG4gICAgICB1c2VyUG9vbE5hbWU6ICdzY2EtdXNlci1wb29sJyxcbiAgICAgIHNlbGZTaWduVXBFbmFibGVkOiB0cnVlLFxuICAgICAgc2lnbkluQWxpYXNlczoge1xuICAgICAgICBlbWFpbDogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICBhdXRvVmVyaWZ5OiB7XG4gICAgICAgIGVtYWlsOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIHBhc3N3b3JkUG9saWN5OiB7XG4gICAgICAgIG1pbkxlbmd0aDogOCxcbiAgICAgICAgcmVxdWlyZUxvd2VyY2FzZTogdHJ1ZSxcbiAgICAgICAgcmVxdWlyZVVwcGVyY2FzZTogdHJ1ZSxcbiAgICAgICAgcmVxdWlyZURpZ2l0czogdHJ1ZSxcbiAgICAgICAgcmVxdWlyZVN5bWJvbHM6IHRydWUsXG4gICAgICB9LFxuICAgICAgYWNjb3VudFJlY292ZXJ5OiBjb2duaXRvLkFjY291bnRSZWNvdmVyeS5FTUFJTF9PTkxZLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSwgLy8gRm9yIGRldmVsb3BtZW50XG4gICAgfSk7XG5cbiAgICAvLyBDb2duaXRvIFVzZXIgUG9vbCBDbGllbnRcbiAgICBjb25zdCB1c2VyUG9vbENsaWVudCA9IHRoaXMuY29nbml0b1VzZXJQb29sLmFkZENsaWVudCgnV2ViQXBwQ2xpZW50Jywge1xuICAgICAgdXNlclBvb2xDbGllbnROYW1lOiAnc2NhLXdlYi1hcHAtY2xpZW50JyxcbiAgICAgIGdlbmVyYXRlU2VjcmV0OiBmYWxzZSxcbiAgICAgIGF1dGhGbG93czoge1xuICAgICAgICB1c2VyU3JwOiB0cnVlLFxuICAgICAgICB1c2VyUGFzc3dvcmQ6IHRydWUsXG4gICAgICB9LFxuICAgICAgb0F1dGg6IHtcbiAgICAgICAgZmxvd3M6IHtcbiAgICAgICAgICBhdXRob3JpemF0aW9uQ29kZUdyYW50OiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICBzY29wZXM6IFtjb2duaXRvLk9BdXRoU2NvcGUuT1BFTklELCBjb2duaXRvLk9BdXRoU2NvcGUuRU1BSUwsIGNvZ25pdG8uT0F1dGhTY29wZS5QUk9GSUxFXSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBDb2duaXRvIFVzZXIgR3JvdXAgZm9yIGFuYWx5c3RzXG4gICAgY29uc3QgYW5hbHlzdEdyb3VwID0gbmV3IGNvZ25pdG8uQ2ZuVXNlclBvb2xHcm91cCh0aGlzLCAnQW5hbHlzdEdyb3VwJywge1xuICAgICAgdXNlclBvb2xJZDogdGhpcy5jb2duaXRvVXNlclBvb2wudXNlclBvb2xJZCxcbiAgICAgIGdyb3VwTmFtZTogJ0FuYWx5c3RzJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29udGFjdCBjZW50ZXIgYW5hbHlzdHMgd2hvIGNhbiB2aWV3IGFuZCBhbmFseXplIGNvbnZlcnNhdGlvbnMnLFxuICAgICAgcHJlY2VkZW5jZTogMSxcbiAgICB9KTtcblxuICAgIC8vIENvZ25pdG8gVXNlciBHcm91cCBmb3IgYWRtaW5pc3RyYXRvcnNcbiAgICBjb25zdCBhZG1pbkdyb3VwID0gbmV3IGNvZ25pdG8uQ2ZuVXNlclBvb2xHcm91cCh0aGlzLCAnQWRtaW5Hcm91cCcsIHtcbiAgICAgIHVzZXJQb29sSWQ6IHRoaXMuY29nbml0b1VzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICBncm91cE5hbWU6ICdBZG1pbmlzdHJhdG9ycycsXG4gICAgICBkZXNjcmlwdGlvbjogJ1N5c3RlbSBhZG1pbmlzdHJhdG9ycyB3aXRoIGZ1bGwgYWNjZXNzJyxcbiAgICAgIHByZWNlZGVuY2U6IDAsXG4gICAgfSk7XG5cbiAgICAvLyBVc2VycyBjYW4gYmUgY3JlYXRlZCB2aWEgdGhlIHNldHVwLXRlc3QtdXNlci5zaCBzY3JpcHRcbiAgICAvLyBVc2FnZTogLi9zY3JpcHRzL3NldHVwLXRlc3QtdXNlci5zaCA8ZW1haWw+IFtncm91cC1uYW1lXVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEFwcFN5bmMgRXZlbnRzIEFQSSBTZXR1cCAtIFJFTU9WRURcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQXBwU3luYyBFdmVudHMgY2Fubm90IGJlIGFjY2Vzc2VkIHByaXZhdGVseSB3aXRob3V0IFZQQyBlbmRwb2ludCBzdXBwb3J0XG4gICAgLy8gU3dpdGNoZWQgdG8gcG9sbGluZy1iYXNlZCBhcHByb2FjaCBmb3IgcmVhbC10aW1lIHVwZGF0ZXNcbiAgICBcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQW5hbHl0aWNzIFByb2Nlc3NvciBMYW1iZGEgRnVuY3Rpb25cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gVHJpZ2dlcmVkIGJ5IER5bmFtb0RCIFN0cmVhbXMgZnJvbSBUcmFuc2NyaXB0aW9ucyB0YWJsZVxuICAgIGNvbnN0IGFuYWx5dGljc1Byb2Nlc3NvckZ1bmN0aW9uID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnQW5hbHl0aWNzUHJvY2Vzc29yJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc2NhLWFuYWx5dGljcy1wcm9jZXNzb3InLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTMsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlci5sYW1iZGFfaGFuZGxlcicsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uLy4uL2JhY2tlbmQvYW5hbHl0aWNzLXByb2Nlc3NvcicpKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgbWVtb3J5U2l6ZTogMTAyNCwgLy8gSGlnaGVyIG1lbW9yeSBmb3IgQmVkcm9jayBBUEkgY2FsbHNcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFRSQU5TQ1JJUFRJT05TX1RBQkxFOiB0aGlzLnRyYW5zY3JpcHRpb25zVGFibGUudGFibGVOYW1lLFxuICAgICAgICBBTkFMWVRJQ1NfVEFCTEU6IHRoaXMuYW5hbHl0aWNzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBQT1dFUlRPT0xTX1NFUlZJQ0VfTkFNRTogJ2FuYWx5dGljcy1wcm9jZXNzb3InLFxuICAgICAgICBQT1dFUlRPT0xTX01FVFJJQ1NfTkFNRVNQQUNFOiAnU0NBJyxcbiAgICAgICAgTE9HX0xFVkVMOiAnSU5GTycsXG4gICAgICB9LFxuICAgICAgdHJhY2luZzogbGFtYmRhLlRyYWNpbmcuQUNUSVZFLFxuICAgIH0pO1xuXG4gICAgLy8gR3JhbnQgcGVybWlzc2lvbnMgdG8gdGhlIEFuYWx5dGljcyBQcm9jZXNzb3IgTGFtYmRhXG4gICAgdGhpcy50cmFuc2NyaXB0aW9uc1RhYmxlLmdyYW50UmVhZERhdGEoYW5hbHl0aWNzUHJvY2Vzc29yRnVuY3Rpb24pO1xuICAgIHRoaXMuYW5hbHl0aWNzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGFuYWx5dGljc1Byb2Nlc3NvckZ1bmN0aW9uKTtcbiAgICBcbiAgICAvLyBHcmFudCBCZWRyb2NrIHBlcm1pc3Npb25zIGZvciBBSSBhbmFseXRpY3NcbiAgICBhbmFseXRpY3NQcm9jZXNzb3JGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICdiZWRyb2NrOkludm9rZU1vZGVsJyxcbiAgICAgICAgICAnYmVkcm9jazpJbnZva2VNb2RlbFdpdGhSZXNwb25zZVN0cmVhbScsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgIGBhcm46YXdzOmJlZHJvY2s6JHt0aGlzLnJlZ2lvbn06OmZvdW5kYXRpb24tbW9kZWwvYW50aHJvcGljLmNsYXVkZS0zLWhhaWt1LTIwMjQwMzA3LXYxOjBgLFxuICAgICAgICBdLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gQWRkIER5bmFtb0RCIFN0cmVhbXMgZXZlbnQgc291cmNlIHRvIEFuYWx5dGljcyBQcm9jZXNzb3IgTGFtYmRhXG4gICAgYW5hbHl0aWNzUHJvY2Vzc29yRnVuY3Rpb24uYWRkRXZlbnRTb3VyY2UoXG4gICAgICBuZXcgbGFtYmRhRXZlbnRTb3VyY2VzLkR5bmFtb0V2ZW50U291cmNlKHRoaXMudHJhbnNjcmlwdGlvbnNUYWJsZSwge1xuICAgICAgICBzdGFydGluZ1Bvc2l0aW9uOiBsYW1iZGEuU3RhcnRpbmdQb3NpdGlvbi5MQVRFU1QsXG4gICAgICAgIGJhdGNoU2l6ZTogMTAsXG4gICAgICAgIG1heEJhdGNoaW5nV2luZG93OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg1KSxcbiAgICAgICAgcmV0cnlBdHRlbXB0czogMyxcbiAgICAgICAgYmlzZWN0QmF0Y2hPbkVycm9yOiB0cnVlLFxuICAgICAgICByZXBvcnRCYXRjaEl0ZW1GYWlsdXJlczogdHJ1ZSxcbiAgICAgICAgZmlsdGVyczogW1xuICAgICAgICAgIC8vIE9ubHkgcHJvY2VzcyBJTlNFUlQgYW5kIE1PRElGWSBldmVudHNcbiAgICAgICAgICBsYW1iZGEuRmlsdGVyQ3JpdGVyaWEuZmlsdGVyKHtcbiAgICAgICAgICAgIGV2ZW50TmFtZTogbGFtYmRhLkZpbHRlclJ1bGUuaXNFcXVhbCgnSU5TRVJUJyksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgbGFtYmRhLkZpbHRlckNyaXRlcmlhLmZpbHRlcih7XG4gICAgICAgICAgICBldmVudE5hbWU6IGxhbWJkYS5GaWx0ZXJSdWxlLmlzRXF1YWwoJ01PRElGWScpLFxuICAgICAgICAgIH0pLFxuICAgICAgICBdLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIERhdGEgUmV0cmlldmFsIExhbWJkYSBGdW5jdGlvblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBQcm92aWRlcyBSRVNUIEFQSSBmb3IgcXVlcnlpbmcgdHJhbnNjcmlwdGlvbnMgYW5kIGFuYWx5dGljc1xuICAgIGNvbnN0IGRhdGFSZXRyaWV2YWxGdW5jdGlvbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0RhdGFSZXRyaWV2YWwnLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzY2EtZGF0YS1yZXRyaWV2YWwnLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTMsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlci5sYW1iZGFfaGFuZGxlcicsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uLy4uL2JhY2tlbmQvZGF0YS1yZXRyaWV2YWwnKSksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiA1MTIsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBUUkFOU0NSSVBUSU9OU19UQUJMRTogdGhpcy50cmFuc2NyaXB0aW9uc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgQU5BTFlUSUNTX1RBQkxFOiB0aGlzLmFuYWx5dGljc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgUE9XRVJUT09MU19TRVJWSUNFX05BTUU6ICdkYXRhLXJldHJpZXZhbCcsXG4gICAgICAgIFBPV0VSVE9PTFNfTUVUUklDU19OQU1FU1BBQ0U6ICdTQ0EnLFxuICAgICAgICBMT0dfTEVWRUw6ICdJTkZPJyxcbiAgICAgIH0sXG4gICAgICB0cmFjaW5nOiBsYW1iZGEuVHJhY2luZy5BQ1RJVkUsXG4gICAgfSk7XG5cbiAgICAvLyBHcmFudCByZWFkIHBlcm1pc3Npb25zIHRvIHRoZSBEYXRhIFJldHJpZXZhbCBMYW1iZGFcbiAgICB0aGlzLnRyYW5zY3JpcHRpb25zVGFibGUuZ3JhbnRSZWFkRGF0YShkYXRhUmV0cmlldmFsRnVuY3Rpb24pO1xuICAgIHRoaXMuYW5hbHl0aWNzVGFibGUuZ3JhbnRSZWFkRGF0YShkYXRhUmV0cmlldmFsRnVuY3Rpb24pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFZQQyBFbmRwb2ludHMgZm9yIFByaXZhdGUgQ29ubmVjdGl2aXR5XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIFxuICAgIC8vIFMzIEdhdGV3YXkgRW5kcG9pbnQgKGZvciBFQ1IgaW1hZ2UgbGF5ZXJzIC0gbm8gaG91cmx5IGNoYXJnZSlcbiAgICB0aGlzLnZwYy5hZGRHYXRld2F5RW5kcG9pbnQoJ1MzR2F0ZXdheUVuZHBvaW50Jywge1xuICAgICAgc2VydmljZTogZWMyLkdhdGV3YXlWcGNFbmRwb2ludEF3c1NlcnZpY2UuUzMsXG4gICAgICBzdWJuZXRzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX0lTT0xBVEVELFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIC8vIEVDUiBBUEkgRW5kcG9pbnQgKGZvciBFQ1MgdG8gYXV0aGVudGljYXRlIGFuZCBnZXQgaW1hZ2UgbWFuaWZlc3RzKVxuICAgIG5ldyBlYzIuSW50ZXJmYWNlVnBjRW5kcG9pbnQodGhpcywgJ0VjckFwaVZwY0VuZHBvaW50Jywge1xuICAgICAgdnBjOiB0aGlzLnZwYyxcbiAgICAgIHNlcnZpY2U6IGVjMi5JbnRlcmZhY2VWcGNFbmRwb2ludEF3c1NlcnZpY2UuRUNSLFxuICAgICAgcHJpdmF0ZURuc0VuYWJsZWQ6IHRydWUsXG4gICAgICBzdWJuZXRzOiB7XG4gICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gRUNSIERvY2tlciBFbmRwb2ludCAoZm9yIEVDUyB0byBwdWxsIERvY2tlciBpbWFnZXMpXG4gICAgbmV3IGVjMi5JbnRlcmZhY2VWcGNFbmRwb2ludCh0aGlzLCAnRWNyRGtyVnBjRW5kcG9pbnQnLCB7XG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgc2VydmljZTogZWMyLkludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5FQ1JfRE9DS0VSLFxuICAgICAgcHJpdmF0ZURuc0VuYWJsZWQ6IHRydWUsXG4gICAgICBzdWJuZXRzOiB7XG4gICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQ2xvdWRXYXRjaCBMb2dzIEVuZHBvaW50IChmb3IgRUNTIGNvbnRhaW5lciBsb2dnaW5nKVxuICAgIG5ldyBlYzIuSW50ZXJmYWNlVnBjRW5kcG9pbnQodGhpcywgJ0Nsb3VkV2F0Y2hMb2dzVnBjRW5kcG9pbnQnLCB7XG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgc2VydmljZTogZWMyLkludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5DTE9VRFdBVENIX0xPR1MsXG4gICAgICBwcml2YXRlRG5zRW5hYmxlZDogdHJ1ZSxcbiAgICAgIHN1Ym5ldHM6IHtcbiAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9JU09MQVRFRCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gUHJpdmF0ZSBBUEkgR2F0ZXdheSBmb3IgRGF0YSBSZXRyaWV2YWxcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ3JlYXRlIFZQQyBFbmRwb2ludCBmb3IgQVBJIEdhdGV3YXkgKHJlcXVpcmVkIGZvciBwcml2YXRlIEFQSSlcbiAgICBjb25zdCBhcGlHYXRld2F5VnBjRW5kcG9pbnQgPSBuZXcgZWMyLkludGVyZmFjZVZwY0VuZHBvaW50KHRoaXMsICdBcGlHYXRld2F5VnBjRW5kcG9pbnQnLCB7XG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgc2VydmljZTogZWMyLkludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5BUElHQVRFV0FZLFxuICAgICAgcHJpdmF0ZURuc0VuYWJsZWQ6IHRydWUsXG4gICAgICBzdWJuZXRzOiB7XG4gICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIHByaXZhdGUgUkVTVCBBUElcbiAgICBjb25zdCBkYXRhUmV0cmlldmFsQXBpID0gbmV3IGFwaWdhdGV3YXkuUmVzdEFwaSh0aGlzLCAnRGF0YVJldHJpZXZhbEFwaScsIHtcbiAgICAgIHJlc3RBcGlOYW1lOiAnc2NhLWRhdGEtcmV0cmlldmFsLWFwaScsXG4gICAgICBkZXNjcmlwdGlvbjogJ1ByaXZhdGUgQVBJIGZvciBxdWVyeWluZyBjb250YWN0IHRyYW5zY3JpcHRpb25zIGFuZCBhbmFseXRpY3MnLFxuICAgICAgZW5kcG9pbnRDb25maWd1cmF0aW9uOiB7XG4gICAgICAgIHR5cGVzOiBbYXBpZ2F0ZXdheS5FbmRwb2ludFR5cGUuUFJJVkFURV0sXG4gICAgICAgIHZwY0VuZHBvaW50czogW2FwaUdhdGV3YXlWcGNFbmRwb2ludF0sXG4gICAgICB9LFxuICAgICAgcG9saWN5OiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgIHByaW5jaXBhbHM6IFtuZXcgaWFtLkFueVByaW5jaXBhbCgpXSxcbiAgICAgICAgICAgIGFjdGlvbnM6IFsnZXhlY3V0ZS1hcGk6SW52b2tlJ10sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFsnZXhlY3V0ZS1hcGk6LyonXSxcbiAgICAgICAgICAgIGNvbmRpdGlvbnM6IHtcbiAgICAgICAgICAgICAgU3RyaW5nRXF1YWxzOiB7XG4gICAgICAgICAgICAgICAgJ2F3czpTb3VyY2VWcGNlJzogYXBpR2F0ZXdheVZwY0VuZHBvaW50LnZwY0VuZHBvaW50SWQsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pLFxuICAgICAgICBdLFxuICAgICAgfSksXG4gICAgICBkZXBsb3lPcHRpb25zOiB7XG4gICAgICAgIHN0YWdlTmFtZTogJ3Byb2QnLFxuICAgICAgICB0cmFjaW5nRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgbG9nZ2luZ0xldmVsOiBhcGlnYXRld2F5Lk1ldGhvZExvZ2dpbmdMZXZlbC5JTkZPLFxuICAgICAgICBkYXRhVHJhY2VFbmFibGVkOiB0cnVlLFxuICAgICAgICBtZXRyaWNzRW5hYmxlZDogdHJ1ZSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgTGFtYmRhIGludGVncmF0aW9uXG4gICAgY29uc3QgZGF0YVJldHJpZXZhbEludGVncmF0aW9uID0gbmV3IGFwaWdhdGV3YXkuTGFtYmRhSW50ZWdyYXRpb24oZGF0YVJldHJpZXZhbEZ1bmN0aW9uLCB7XG4gICAgICBwcm94eTogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBBUEkgR2F0ZXdheSByb3V0ZXNcbiAgICBkYXRhUmV0cmlldmFsQXBpLnJvb3QuYWRkTWV0aG9kKCdBTlknLCBkYXRhUmV0cmlldmFsSW50ZWdyYXRpb24pO1xuICAgIGRhdGFSZXRyaWV2YWxBcGkucm9vdC5hZGRQcm94eSh7XG4gICAgICBkZWZhdWx0SW50ZWdyYXRpb246IGRhdGFSZXRyaWV2YWxJbnRlZ3JhdGlvbixcbiAgICAgIGFueU1ldGhvZDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIEVDUyBDbHVzdGVyIGluIHByaXZhdGUgc3VibmV0c1xuICAgIHRoaXMuZWNzQ2x1c3RlciA9IG5ldyBlY3MuQ2x1c3Rlcih0aGlzLCAnRWNzQ2x1c3RlcicsIHtcbiAgICAgIGNsdXN0ZXJOYW1lOiAnc2NhLWNsdXN0ZXInLFxuICAgICAgdnBjOiB0aGlzLnZwYyxcbiAgICAgIGNvbnRhaW5lckluc2lnaHRzOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gU2VjdXJpdHkgZ3JvdXAgZm9yIEFMQlxuICAgIGNvbnN0IGFsYlNlY3VyaXR5R3JvdXAgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ0FsYlNlY3VyaXR5R3JvdXAnLCB7XG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgZGVzY3JpcHRpb246ICdTZWN1cml0eSBncm91cCBmb3IgU0NBIEFwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXInLFxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIE9wdGlvbmFsOiBBbGxvdyBpbmJvdW5kIHRyYWZmaWMgZnJvbSBzcGVjaWZpYyBDSURSIGJsb2NrcyAob25seSBpZiBleHBsaWNpdGx5IGNvbmZpZ3VyZWQpXG4gICAgY29uc3QgYWxsb3dlZENpZHJCbG9ja3MgPSB0aGlzLm5vZGUudHJ5R2V0Q29udGV4dCgnYWxsb3dlZENpZHJCbG9ja3MnKTtcbiAgICBpZiAoYWxsb3dlZENpZHJCbG9ja3MgJiYgQXJyYXkuaXNBcnJheShhbGxvd2VkQ2lkckJsb2NrcykpIHtcbiAgICAgIGFsbG93ZWRDaWRyQmxvY2tzLmZvckVhY2goKGNpZHI6IHN0cmluZykgPT4ge1xuICAgICAgICBhbGJTZWN1cml0eUdyb3VwLmFkZEluZ3Jlc3NSdWxlKFxuICAgICAgICAgIGVjMi5QZWVyLmlwdjQoY2lkciksXG4gICAgICAgICAgZWMyLlBvcnQudGNwKDgwKSxcbiAgICAgICAgICBgQWxsb3cgSFRUUCBmcm9tICR7Y2lkcn1gXG4gICAgICAgICk7XG4gICAgICAgIGFsYlNlY3VyaXR5R3JvdXAuYWRkSW5ncmVzc1J1bGUoXG4gICAgICAgICAgZWMyLlBlZXIuaXB2NChjaWRyKSxcbiAgICAgICAgICBlYzIuUG9ydC50Y3AoNDQzKSxcbiAgICAgICAgICBgQWxsb3cgSFRUUFMgZnJvbSAke2NpZHJ9YFxuICAgICAgICApO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gUHJpdmF0ZSBBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyIChpbiBpc29sYXRlZCBzdWJuZXRzKVxuICAgIHRoaXMuYWxiID0gbmV3IGVsYnYyLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyKHRoaXMsICdQcml2YXRlQWxiJywge1xuICAgICAgdnBjOiB0aGlzLnZwYyxcbiAgICAgIGludGVybmV0RmFjaW5nOiBmYWxzZSxcbiAgICAgIHNlY3VyaXR5R3JvdXA6IGFsYlNlY3VyaXR5R3JvdXAsXG4gICAgICB2cGNTdWJuZXRzOiB7XG4gICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQsXG4gICAgICB9LFxuICAgIH0pO1xuICAgIFxuICAgIC8vIE92ZXJyaWRlIGxvZ2ljYWwgSUQgdG8gZW5zdXJlIHN0YWJsZSBDbG91ZEZvcm1hdGlvbiBleHBvcnRzXG4gICAgLy8gVGhpcyBwcmV2ZW50cyBicmVha2luZyBjaGFuZ2VzIHdoZW4gY29kZSBpcyByZW9yZ2FuaXplZFxuICAgICh0aGlzLmFsYi5ub2RlLmRlZmF1bHRDaGlsZCBhcyBlbGJ2Mi5DZm5Mb2FkQmFsYW5jZXIpLm92ZXJyaWRlTG9naWNhbElkKCdQcml2YXRlQWxiRjA3QTk0RDUnKTtcblxuICAgIC8vIFNlY3VyaXR5IGdyb3VwIGZvciBFQ1MgdGFza3NcbiAgICBjb25zdCBlY3NTZWN1cml0eUdyb3VwID0gbmV3IGVjMi5TZWN1cml0eUdyb3VwKHRoaXMsICdFY3NTZWN1cml0eUdyb3VwJywge1xuICAgICAgdnBjOiB0aGlzLnZwYyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU2VjdXJpdHkgZ3JvdXAgZm9yIFNDQSBFQ1MgdGFza3MnLFxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIEFsbG93IEFMQiB0byBjb21tdW5pY2F0ZSB3aXRoIEVDUyB0YXNrc1xuICAgIGVjc1NlY3VyaXR5R3JvdXAuYWRkSW5ncmVzc1J1bGUoXG4gICAgICBhbGJTZWN1cml0eUdyb3VwLFxuICAgICAgZWMyLlBvcnQudGNwKDMwMDApLFxuICAgICAgJ0FsbG93IEFMQiB0byByZWFjaCBFQ1MgdGFza3MnXG4gICAgKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBFQ1MgVGFzayBEZWZpbml0aW9uIGFuZCBTZXJ2aWNlXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIFxuICAgIC8vIElBTSByb2xlIGZvciBFQ1MgdGFzayBleGVjdXRpb24gKHB1bGwgaW1hZ2VzLCB3cml0ZSBsb2dzKVxuICAgIGNvbnN0IHRhc2tFeGVjdXRpb25Sb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdFY3NUYXNrRXhlY3V0aW9uUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdlY3MtdGFza3MuYW1hem9uYXdzLmNvbScpLFxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZSgnc2VydmljZS1yb2xlL0FtYXpvbkVDU1Rhc2tFeGVjdXRpb25Sb2xlUG9saWN5JyksXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgLy8gR3JhbnQgRUNSIHB1bGwgcGVybWlzc2lvbnNcbiAgICBlY3JSZXBvc2l0b3J5LmdyYW50UHVsbCh0YXNrRXhlY3V0aW9uUm9sZSk7XG5cbiAgICAvLyBJQU0gcm9sZSBmb3IgRUNTIHRhc2sgKGFwcGxpY2F0aW9uIHBlcm1pc3Npb25zKVxuICAgIGNvbnN0IHRhc2tSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdFY3NUYXNrUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdlY3MtdGFza3MuYW1hem9uYXdzLmNvbScpLFxuICAgIH0pO1xuXG4gICAgLy8gRUNTIFRhc2sgRGVmaW5pdGlvblxuICAgIGNvbnN0IHRhc2tEZWZpbml0aW9uID0gbmV3IGVjcy5GYXJnYXRlVGFza0RlZmluaXRpb24odGhpcywgJ1dlYkFwcFRhc2tEZWZpbml0aW9uJywge1xuICAgICAgZmFtaWx5OiAnc2NhLXdlYi1hcHAnLFxuICAgICAgY3B1OiAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogNTEyLFxuICAgICAgZXhlY3V0aW9uUm9sZTogdGFza0V4ZWN1dGlvblJvbGUsXG4gICAgICB0YXNrUm9sZTogdGFza1JvbGUsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgY29udGFpbmVyIHRvIHRhc2sgZGVmaW5pdGlvblxuICAgIGNvbnN0IGNvbnRhaW5lciA9IHRhc2tEZWZpbml0aW9uLmFkZENvbnRhaW5lcignV2ViQXBwQ29udGFpbmVyJywge1xuICAgICAgY29udGFpbmVyTmFtZTogJ3NjYS13ZWItYXBwJyxcbiAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbUVjclJlcG9zaXRvcnkoZWNyUmVwb3NpdG9yeSwgJ2xhdGVzdCcpLFxuICAgICAgbG9nZ2luZzogZWNzLkxvZ0RyaXZlcnMuYXdzTG9ncyh7XG4gICAgICAgIHN0cmVhbVByZWZpeDogJ3NjYS13ZWItYXBwJyxcbiAgICAgICAgbG9nUmV0ZW50aW9uOiA3LCAvLyA3IGRheXMgcmV0ZW50aW9uXG4gICAgICB9KSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIC8vIFJlYWN0IGJ1aWxkLXRpbWUgZW52aXJvbm1lbnQgdmFyaWFibGVzIChlbWJlZGRlZCBpbiBKUyBidW5kbGUpXG4gICAgICAgIFJFQUNUX0FQUF9VU0VSX1BPT0xfSUQ6IHRoaXMuY29nbml0b1VzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICAgIFJFQUNUX0FQUF9VU0VSX1BPT0xfQ0xJRU5UX0lEOiB1c2VyUG9vbENsaWVudC51c2VyUG9vbENsaWVudElkLFxuICAgICAgICBSRUFDVF9BUFBfQVBJX0VORFBPSU5UOiBkYXRhUmV0cmlldmFsQXBpLnVybCwgLy8gS2VlcCBmb3IgYmFja3dhcmRzIGNvbXBhdGliaWxpdHlcbiAgICAgICAgUkVBQ1RfQVBQX0FXU19SRUdJT046IHRoaXMucmVnaW9uLFxuICAgICAgICAvLyBOZ2lueCBydW50aW1lIGVudmlyb25tZW50IHZhcmlhYmxlIGZvciBBUEkgcHJveHkgLSBNVVNUIHVzZSBWUEMgZW5kcG9pbnQgZm9ybWF0XG4gICAgICAgIEFQSV9FTkRQT0lOVDogYGh0dHBzOi8vJHtkYXRhUmV0cmlldmFsQXBpLnJlc3RBcGlJZH0tJHthcGlHYXRld2F5VnBjRW5kcG9pbnQudnBjRW5kcG9pbnRJZH0uZXhlY3V0ZS1hcGkuJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbS9wcm9kL2AsXG4gICAgICB9LFxuICAgICAgaGVhbHRoQ2hlY2s6IHtcbiAgICAgICAgY29tbWFuZDogWydDTUQtU0hFTEwnLCAnY3VybCAtZiBodHRwOi8vbG9jYWxob3N0OjMwMDAvaGVhbHRoIHx8IGV4aXQgMSddLFxuICAgICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg1KSxcbiAgICAgICAgcmV0cmllczogMyxcbiAgICAgICAgc3RhcnRQZXJpb2Q6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDYwKSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgcG9ydCBtYXBwaW5nXG4gICAgY29udGFpbmVyLmFkZFBvcnRNYXBwaW5ncyh7XG4gICAgICBjb250YWluZXJQb3J0OiAzMDAwLFxuICAgICAgcHJvdG9jb2w6IGVjcy5Qcm90b2NvbC5UQ1AsXG4gICAgfSk7XG5cbiAgICAvLyBFQ1MgU2VydmljZVxuICAgIGNvbnN0IGVjc1NlcnZpY2UgPSBuZXcgZWNzLkZhcmdhdGVTZXJ2aWNlKHRoaXMsICdXZWJBcHBTZXJ2aWNlJywge1xuICAgICAgc2VydmljZU5hbWU6ICdzY2Etd2ViLWFwcC1zZXJ2aWNlJyxcbiAgICAgIGNsdXN0ZXI6IHRoaXMuZWNzQ2x1c3RlcixcbiAgICAgIHRhc2tEZWZpbml0aW9uOiB0YXNrRGVmaW5pdGlvbixcbiAgICAgIGRlc2lyZWRDb3VudDogMiwgLy8gUnVuIDIgdGFza3MgZm9yIGhpZ2ggYXZhaWxhYmlsaXR5XG4gICAgICBtaW5IZWFsdGh5UGVyY2VudDogNTAsXG4gICAgICBtYXhIZWFsdGh5UGVyY2VudDogMjAwLFxuICAgICAgc2VjdXJpdHlHcm91cHM6IFtlY3NTZWN1cml0eUdyb3VwXSxcbiAgICAgIHZwY1N1Ym5ldHM6IHtcbiAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9JU09MQVRFRCxcbiAgICAgIH0sXG4gICAgICBlbmFibGVFeGVjdXRlQ29tbWFuZDogdHJ1ZSwgLy8gRW5hYmxlIEVDUyBFeGVjIGZvciBkZWJ1Z2dpbmdcbiAgICAgIGNpcmN1aXRCcmVha2VyOiB7XG4gICAgICAgIHJvbGxiYWNrOiB0cnVlLCAvLyBBdXRvbWF0aWMgcm9sbGJhY2sgb24gZGVwbG95bWVudCBmYWlsdXJlXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQUxCIFRhcmdldCBHcm91cCBmb3IgRUNTIFNlcnZpY2VcbiAgICBjb25zdCB0YXJnZXRHcm91cCA9IG5ldyBlbGJ2Mi5BcHBsaWNhdGlvblRhcmdldEdyb3VwKHRoaXMsICdXZWJBcHBUYXJnZXRHcm91cCcsIHtcbiAgICAgIHZwYzogdGhpcy52cGMsXG4gICAgICBwb3J0OiAzMDAwLFxuICAgICAgcHJvdG9jb2w6IGVsYnYyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICAgIHRhcmdldFR5cGU6IGVsYnYyLlRhcmdldFR5cGUuSVAsXG4gICAgICBoZWFsdGhDaGVjazoge1xuICAgICAgICBwYXRoOiAnL2hlYWx0aCcsXG4gICAgICAgIGludGVydmFsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgICAgICBoZWFsdGh5VGhyZXNob2xkQ291bnQ6IDIsXG4gICAgICAgIHVuaGVhbHRoeVRocmVzaG9sZENvdW50OiAzLFxuICAgICAgICBoZWFsdGh5SHR0cENvZGVzOiAnMjAwJyxcbiAgICAgIH0sXG4gICAgICBkZXJlZ2lzdHJhdGlvbkRlbGF5OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgfSk7XG5cbiAgICAvLyBSZWdpc3RlciBFQ1Mgc2VydmljZSB3aXRoIHRhcmdldCBncm91cFxuICAgIGVjc1NlcnZpY2UuYXR0YWNoVG9BcHBsaWNhdGlvblRhcmdldEdyb3VwKHRhcmdldEdyb3VwKTtcblxuICAgIC8vIEFMQiBMaXN0ZW5lciAoSFRUUCBvbiBwb3J0IDgwKVxuICAgIC8vIE5vdGU6IG9wZW46IGZhbHNlIHByZXZlbnRzIENESyBmcm9tIGF1dG9tYXRpY2FsbHkgYWRkaW5nIDAuMC4wLjAvMCBpbmdyZXNzIHJ1bGVcbiAgICBjb25zdCBsaXN0ZW5lciA9IHRoaXMuYWxiLmFkZExpc3RlbmVyKCdIdHRwTGlzdGVuZXInLCB7XG4gICAgICBwb3J0OiA4MCxcbiAgICAgIHByb3RvY29sOiBlbGJ2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFAsXG4gICAgICBkZWZhdWx0QWN0aW9uOiBlbGJ2Mi5MaXN0ZW5lckFjdGlvbi5mb3J3YXJkKFt0YXJnZXRHcm91cF0pLFxuICAgICAgb3BlbjogZmFsc2UsIC8vIERvbid0IGF1dG9tYXRpY2FsbHkgYWRkIDAuMC4wLjAvMCBpbmdyZXNzIHJ1bGVcbiAgICB9KTtcblxuICAgIC8vIEF1dG8tc2NhbGluZyBjb25maWd1cmF0aW9uXG4gICAgY29uc3Qgc2NhbGluZyA9IGVjc1NlcnZpY2UuYXV0b1NjYWxlVGFza0NvdW50KHtcbiAgICAgIG1pbkNhcGFjaXR5OiAyLFxuICAgICAgbWF4Q2FwYWNpdHk6IDEwLFxuICAgIH0pO1xuXG4gICAgLy8gU2NhbGUgYmFzZWQgb24gQ1BVIHV0aWxpemF0aW9uXG4gICAgc2NhbGluZy5zY2FsZU9uQ3B1VXRpbGl6YXRpb24oJ0NwdVNjYWxpbmcnLCB7XG4gICAgICB0YXJnZXRVdGlsaXphdGlvblBlcmNlbnQ6IDcwLFxuICAgICAgc2NhbGVJbkNvb2xkb3duOiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MCksXG4gICAgICBzY2FsZU91dENvb2xkb3duOiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MCksXG4gICAgfSk7XG5cbiAgICAvLyBTY2FsZSBiYXNlZCBvbiBtZW1vcnkgdXRpbGl6YXRpb25cbiAgICBzY2FsaW5nLnNjYWxlT25NZW1vcnlVdGlsaXphdGlvbignTWVtb3J5U2NhbGluZycsIHtcbiAgICAgIHRhcmdldFV0aWxpemF0aW9uUGVyY2VudDogODAsXG4gICAgICBzY2FsZUluQ29vbGRvd246IGNkay5EdXJhdGlvbi5zZWNvbmRzKDYwKSxcbiAgICAgIHNjYWxlT3V0Q29vbGRvd246IGNkay5EdXJhdGlvbi5zZWNvbmRzKDYwKSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDbG91ZEZvcm1hdGlvbiBPdXRwdXRzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENSSVRJQ0FMOiBETyBOT1QgYWRkICdleHBvcnROYW1lJyB0byBhbnkgb3V0cHV0cyFcbiAgICAvLyBFeHBvcnRzIGNyZWF0ZSBjcm9zcy1zdGFjayBkZXBlbmRlbmNpZXMgdGhhdCBwcmV2ZW50IHN0YWNrIHVwZGF0ZXMuXG4gICAgLy8gUmVzb3VyY2VzIHNob3VsZCBiZSBwYXNzZWQgZGlyZWN0bHkgdmlhIHN0YWNrIHByb3BzIGluc3RlYWQuXG4gICAgLy8gU2VlOiBpbmZyYXN0cnVjdHVyZS9iaW4vc2NhLWFwcC50cyBmb3IgaG93IHJlc291cmNlcyBhcmUgcGFzc2VkIGJldHdlZW4gc3RhY2tzXG4gICAgXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1ZwY0lkJywge1xuICAgICAgdmFsdWU6IHRoaXMudnBjLnZwY0lkLFxuICAgICAgZGVzY3JpcHRpb246ICdWUEMgSUQgZm9yIHRoZSBTQ0Egc29sdXRpb24nLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1RyYW5zY3JpcHRpb25TdHJlYW1OYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMudHJhbnNjcmlwdGlvblN0cmVhbS5zdHJlYW1OYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdLaW5lc2lzIFN0cmVhbSBuYW1lIGZvciB0cmFuc2NyaXB0aW9uIGluZ2VzdGlvbicsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVHJhbnNjcmlwdGlvblN0cmVhbUFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnRyYW5zY3JpcHRpb25TdHJlYW0uc3RyZWFtQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdLaW5lc2lzIFN0cmVhbSBBUk4gZm9yIHRyYW5zY3JpcHRpb24gaW5nZXN0aW9uJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUcmFuc2NyaXB0aW9uc1RhYmxlTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnRyYW5zY3JpcHRpb25zVGFibGUudGFibGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdEeW5hbW9EQiB0YWJsZSBuYW1lIGZvciB0cmFuc2NyaXB0aW9ucycsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQW5hbHl0aWNzVGFibGVOYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMuYW5hbHl0aWNzVGFibGUudGFibGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdEeW5hbW9EQiB0YWJsZSBuYW1lIGZvciBhbmFseXRpY3MnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RlYWRMZXR0ZXJRdWV1ZVVybCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmRlYWRMZXR0ZXJRdWV1ZS5xdWV1ZVVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU1FTIERlYWQgTGV0dGVyIFF1ZXVlIFVSTCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRWNyUmVwb3NpdG9yeVVyaScsIHtcbiAgICAgIHZhbHVlOiBlY3JSZXBvc2l0b3J5LnJlcG9zaXRvcnlVcmksXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUiByZXBvc2l0b3J5IFVSSSBmb3Igd2ViIGFwcGxpY2F0aW9uIGltYWdlcyAoaW1wb3J0ZWQgZnJvbSBTY2FFY3JTdGFjayknLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1VzZXJQb29sSWQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5jb2duaXRvVXNlclBvb2wudXNlclBvb2xJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBVc2VyIFBvb2wgSUQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1VzZXJQb29sQ2xpZW50SWQnLCB7XG4gICAgICB2YWx1ZTogdXNlclBvb2xDbGllbnQudXNlclBvb2xDbGllbnRJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBVc2VyIFBvb2wgQ2xpZW50IElEJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBbGJEbnNOYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMuYWxiLmxvYWRCYWxhbmNlckRuc05hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ1ByaXZhdGUgQUxCIEROUyBuYW1lJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdFY3NDbHVzdGVyTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmVjc0NsdXN0ZXIuY2x1c3Rlck5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBDbHVzdGVyIG5hbWUnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1RyYW5zY3JpcHRpb25Qcm9jZXNzb3JGdW5jdGlvbk5hbWUnLCB7XG4gICAgICB2YWx1ZTogdHJhbnNjcmlwdGlvblByb2Nlc3NvckZ1bmN0aW9uLmZ1bmN0aW9uTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVHJhbnNjcmlwdGlvbiBQcm9jZXNzb3IgTGFtYmRhIGZ1bmN0aW9uIG5hbWUnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1RyYW5zY3JpcHRpb25Qcm9jZXNzb3JGdW5jdGlvbkFybicsIHtcbiAgICAgIHZhbHVlOiB0cmFuc2NyaXB0aW9uUHJvY2Vzc29yRnVuY3Rpb24uZnVuY3Rpb25Bcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ1RyYW5zY3JpcHRpb24gUHJvY2Vzc29yIExhbWJkYSBmdW5jdGlvbiBBUk4nLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FuYWx5dGljc1Byb2Nlc3NvckZ1bmN0aW9uTmFtZScsIHtcbiAgICAgIHZhbHVlOiBhbmFseXRpY3NQcm9jZXNzb3JGdW5jdGlvbi5mdW5jdGlvbk5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FuYWx5dGljcyBQcm9jZXNzb3IgTGFtYmRhIGZ1bmN0aW9uIG5hbWUnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FuYWx5dGljc1Byb2Nlc3NvckZ1bmN0aW9uQXJuJywge1xuICAgICAgdmFsdWU6IGFuYWx5dGljc1Byb2Nlc3NvckZ1bmN0aW9uLmZ1bmN0aW9uQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdBbmFseXRpY3MgUHJvY2Vzc29yIExhbWJkYSBmdW5jdGlvbiBBUk4nLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RhdGFSZXRyaWV2YWxGdW5jdGlvbk5hbWUnLCB7XG4gICAgICB2YWx1ZTogZGF0YVJldHJpZXZhbEZ1bmN0aW9uLmZ1bmN0aW9uTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRGF0YSBSZXRyaWV2YWwgTGFtYmRhIGZ1bmN0aW9uIG5hbWUnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RhdGFSZXRyaWV2YWxGdW5jdGlvbkFybicsIHtcbiAgICAgIHZhbHVlOiBkYXRhUmV0cmlldmFsRnVuY3Rpb24uZnVuY3Rpb25Bcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0RhdGEgUmV0cmlldmFsIExhbWJkYSBmdW5jdGlvbiBBUk4nLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RhdGFSZXRyaWV2YWxBcGlJZCcsIHtcbiAgICAgIHZhbHVlOiBkYXRhUmV0cmlldmFsQXBpLnJlc3RBcGlJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUHJpdmF0ZSBBUEkgR2F0ZXdheSBJRCBmb3IgZGF0YSByZXRyaWV2YWwnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RhdGFSZXRyaWV2YWxBcGlFbmRwb2ludCcsIHtcbiAgICAgIHZhbHVlOiBkYXRhUmV0cmlldmFsQXBpLnVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUHJpdmF0ZSBBUEkgR2F0ZXdheSBlbmRwb2ludCBmb3IgZGF0YSByZXRyaWV2YWwgKHN0YW5kYXJkIGZvcm1hdCknLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RhdGFSZXRyaWV2YWxBcGlWcGNFbmRwb2ludCcsIHtcbiAgICAgIHZhbHVlOiBgaHR0cHM6Ly8ke2RhdGFSZXRyaWV2YWxBcGkucmVzdEFwaUlkfS0ke2FwaUdhdGV3YXlWcGNFbmRwb2ludC52cGNFbmRwb2ludElkfS5leGVjdXRlLWFwaS4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tL3Byb2QvYCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUHJpdmF0ZSBBUEkgR2F0ZXdheSBlbmRwb2ludCB3aXRoIFZQQyBlbmRwb2ludCBJRCAodXNlIHRoaXMgZm9yIG5naW54IHByb3h5KScsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQXBpR2F0ZXdheVZwY0VuZHBvaW50SWQnLCB7XG4gICAgICB2YWx1ZTogYXBpR2F0ZXdheVZwY0VuZHBvaW50LnZwY0VuZHBvaW50SWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ1ZQQyBFbmRwb2ludCBJRCBmb3IgQVBJIEdhdGV3YXknLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FuYWx5c3RHcm91cE5hbWUnLCB7XG4gICAgICB2YWx1ZTogYW5hbHlzdEdyb3VwLmdyb3VwTmFtZSEsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gVXNlciBHcm91cCBmb3IgYW5hbHlzdHMnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FkbWluR3JvdXBOYW1lJywge1xuICAgICAgdmFsdWU6IGFkbWluR3JvdXAuZ3JvdXBOYW1lISxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBVc2VyIEdyb3VwIGZvciBhZG1pbmlzdHJhdG9ycycsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ3JlYXRlVXNlckNvbW1hbmQnLCB7XG4gICAgICB2YWx1ZTogYC4vc2NyaXB0cy9zZXR1cC10ZXN0LXVzZXIuc2ggPGVtYWlsPiBBbmFseXN0c2AsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvbW1hbmQgdG8gY3JlYXRlIGEgbmV3IENvZ25pdG8gdXNlciB3aXRoIHRlbXBvcmFyeSBwYXNzd29yZCBzZW50IHZpYSBlbWFpbCcsXG4gICAgfSk7XG4gIH1cbn0iXX0=