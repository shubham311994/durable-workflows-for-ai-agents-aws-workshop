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
exports.ScaBackendStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const kinesis = __importStar(require("aws-cdk-lib/aws-kinesis"));
const sqs = __importStar(require("aws-cdk-lib/aws-sqs"));
const cognito = __importStar(require("aws-cdk-lib/aws-cognito"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const lambdaEventSources = __importStar(require("aws-cdk-lib/aws-lambda-event-sources"));
const apigateway = __importStar(require("aws-cdk-lib/aws-apigateway"));
const cdk_nag_1 = require("cdk-nag");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
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
class ScaBackendStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Create CloudWatch Logs role for API Gateway (account-level setting)
        const apiGatewayCloudWatchRole = new iam.Role(this, 'ApiGatewayCloudWatchRole', {
            assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs'),
            ],
        });
        new apigateway.CfnAccount(this, 'ApiGatewayAccount', {
            cloudWatchRoleArn: apiGatewayCloudWatchRole.roleArn,
        });
        // Kinesis Stream for transcription ingestion
        this.transcriptionStream = new kinesis.Stream(this, 'TranscriptionStream', {
            streamName: 'sca-transcription-stream',
            streamMode: kinesis.StreamMode.ON_DEMAND,
            retentionPeriod: cdk.Duration.days(7),
            removalPolicy: cdk.RemovalPolicy.DESTROY, // For development
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
        const transcriptionProcessorFunction = new lambda.Function(this, 'TranscriptionProcessor', {
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'handler.lambda_handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/transcription-processor')),
            timeout: cdk.Duration.minutes(5),
            memorySize: 512,
            layers: [
                lambda.LayerVersion.fromLayerVersionArn(this, 'PowertoolsLayer', `arn:aws:lambda:${this.region}:017000801446:layer:AWSLambdaPowertoolsPythonV3-${config.powertoolsLayer.pythonVersion}-x86_64:${config.powertoolsLayer.version}`),
            ],
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
        cdk_nag_1.NagSuppressions.addResourceSuppressions(this.cognitoUserPool, [
            { id: 'AwsSolutions-COG8', reason: 'Plus tier not required' },
        ]);
        // Cognito User Pool Client
        this.cognitoUserPoolClient = this.cognitoUserPool.addClient('WebAppClient', {
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
        // Cognito User Groups
        new cognito.CfnUserPoolGroup(this, 'AnalystGroup', {
            userPoolId: this.cognitoUserPool.userPoolId,
            groupName: 'Analysts',
            description: 'Contact center analysts who can view and analyze conversations',
            precedence: 1,
        });
        new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
            userPoolId: this.cognitoUserPool.userPoolId,
            groupName: 'Administrators',
            description: 'System administrators with full access',
            precedence: 0,
        });
        // Analytics Processor Lambda Function with Durable Execution
        const analyticsProcessorFunction = new lambda.Function(this, 'AnalyticsProcessor', {
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'handler.lambda_handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/analytics-processor')),
            description: `Analytics processor - deployed at ${new Date().toISOString()}`,
            timeout: cdk.Duration.minutes(15), // Max timeout for Lambda with event source mappings
            memorySize: 1024,
            layers: [
                lambda.LayerVersion.fromLayerVersionArn(this, 'PowertoolsLayerAnalytics', `arn:aws:lambda:${this.region}:017000801446:layer:AWSLambdaPowertoolsPythonV3-${config.powertoolsLayer.pythonVersion}-x86_64:${config.powertoolsLayer.version}`),
            ],
            environment: {
                TRANSCRIPTIONS_TABLE: this.transcriptionsTable.tableName,
                ANALYTICS_TABLE: this.analyticsTable.tableName,
                POWERTOOLS_SERVICE_NAME: 'analytics-processor',
                POWERTOOLS_METRICS_NAMESPACE: 'SCA',
                LOG_LEVEL: 'INFO',
            },
            tracing: lambda.Tracing.ACTIVE,
            // Enable durable execution for resilient multi-step Bedrock processing
            // executionTimeout must be ≤15 minutes for event source mappings
            durableConfig: {
                executionTimeout: cdk.Duration.minutes(15), // Match Lambda timeout for event source compatibility
                retentionPeriod: cdk.Duration.days(7), // Keep execution history for 7 days
            },
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
            resources: ['*'],
        }));
        // Grant AWS Marketplace permissions for Bedrock model subscriptions
        analyticsProcessorFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'aws-marketplace:ViewSubscriptions',
                'aws-marketplace:Subscribe',
            ],
            resources: ['*'],
        }));
        // Create alias for durable function - required for event source mappings
        const analyticsProcessorAlias = new lambda.Alias(this, 'AnalyticsProcessorAlias', {
            aliasName: 'live',
            version: analyticsProcessorFunction.currentVersion,
        });
        // Add DynamoDB Streams event source to the alias (durable functions require qualified ARN)
        analyticsProcessorAlias.addEventSource(new lambdaEventSources.DynamoEventSource(this.transcriptionsTable, {
            startingPosition: lambda.StartingPosition.LATEST,
            batchSize: 10,
            maxBatchingWindow: cdk.Duration.seconds(5),
            retryAttempts: 3,
            bisectBatchOnError: true,
            reportBatchItemFailures: true,
            filters: [
                lambda.FilterCriteria.filter({
                    eventName: lambda.FilterRule.isEqual('INSERT'),
                }),
                lambda.FilterCriteria.filter({
                    eventName: lambda.FilterRule.isEqual('MODIFY'),
                }),
            ],
        }));
        // Data Retrieval Lambda Function
        const dataRetrievalFunction = new lambda.Function(this, 'DataRetrieval', {
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'handler.lambda_handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/data-retrieval'), {
                bundling: {
                    image: lambda.Runtime.PYTHON_3_13.bundlingImage,
                    command: [
                        'bash', '-c',
                        'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output',
                    ],
                },
            }),
            timeout: cdk.Duration.seconds(30),
            memorySize: 512,
            layers: [
                lambda.LayerVersion.fromLayerVersionArn(this, 'PowertoolsLayerDataRetrieval', `arn:aws:lambda:${this.region}:017000801446:layer:AWSLambdaPowertoolsPythonV3-${config.powertoolsLayer.pythonVersion}-x86_64:${config.powertoolsLayer.version}`),
            ],
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
        // Allow data-retrieval to send durable execution callbacks (Lab 5: supervisor review)
        dataRetrievalFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: ['lambda:SendDurableExecutionCallbackSuccess'],
            resources: [`arn:aws:lambda:${this.region}:${this.account}:function:*`],
        }));
        // Create private REST API
        this.dataRetrievalApi = new apigateway.RestApi(this, 'DataRetrievalApi', {
            restApiName: 'sca-data-retrieval-api',
            description: 'Private API for querying contact transcriptions and analytics',
            endpointConfiguration: {
                types: [apigateway.EndpointType.PRIVATE],
                vpcEndpoints: [props.apiGatewayVpcEndpoint],
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
                                'aws:SourceVpce': props.apiGatewayVpcEndpoint.vpcEndpointId,
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
                // Stage variables decouple the API from the chat/voice Lambdas (which live in
                // ScaAiStack). The integration URIs below reference these by name, so the API
                // can be edited/redeployed independently of the Lambdas. Names come from context.
                variables: {
                    startChatFn: this.node.tryGetContext('startChatFunctionName') ?? 'sca-start-chat-contact',
                    startWebRtcFn: this.node.tryGetContext('startWebRtcFunctionName') ?? 'sca-start-webrtc-contact',
                },
            },
        });
        // Add Lambda integration
        const dataRetrievalIntegration = new apigateway.LambdaIntegration(dataRetrievalFunction, {
            proxy: true,
        });
        // Add API Gateway routes
        this.dataRetrievalApi.root.addMethod('ANY', dataRetrievalIntegration);
        this.dataRetrievalApi.root.addProxy({
            defaultIntegration: dataRetrievalIntegration,
            anyMethod: true,
        });
        // ========================================
        // Connect chat/voice routes (decoupled via stage variables)
        // ========================================
        // /chat/start and /call/start are invoked by authenticated CRM users to start an
        // in-app chat (StartChatContact) or browser voice call (StartWebRTCContact). The
        // backing Lambdas live in ScaAiStack (downstream of Connect). To avoid a cross-stack
        // ARN import / circular dependency, the integration URI references the target Lambda
        // by NAME through an API Gateway STAGE VARIABLE (startChatFn / startWebRtcFn, set in
        // deployOptions.variables above from cdk.json context). ScaAiStack grants API Gateway
        // permission to invoke those functions. The API can therefore be changed and
        // redeployed without touching ScaAiStack.
        const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'ChatApiAuthorizer', {
            cognitoUserPools: [this.cognitoUserPool],
            authorizerName: 'sca-chat-authorizer',
        });
        const stageVarProxyIntegration = (stageVarName) => new apigateway.Integration({
            type: apigateway.IntegrationType.AWS_PROXY,
            integrationHttpMethod: 'POST',
            // Reference the Lambda by name via a stage variable — no concrete ARN at synth.
            uri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${this.region}:${this.account}:function:$\{stageVariables.${stageVarName}}/invocations`,
        });
        const chatResource = this.dataRetrievalApi.root.addResource('chat');
        const chatStartResource = chatResource.addResource('start');
        chatStartResource.addMethod('POST', stageVarProxyIntegration('startChatFn'), {
            authorizer: cognitoAuthorizer,
            authorizationType: apigateway.AuthorizationType.COGNITO,
        });
        const callResource = this.dataRetrievalApi.root.addResource('call');
        const callStartResource = callResource.addResource('start');
        callStartResource.addMethod('POST', stageVarProxyIntegration('startWebRtcFn'), {
            authorizer: cognitoAuthorizer,
            authorizationType: apigateway.AuthorizationType.COGNITO,
        });
        // Suppress auth warnings on the new endpoints (they use the Cognito authorizer)
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaBackendStack/DataRetrievalApi/Default/chat/start/POST/Resource', [{ id: 'AwsSolutions-COG4', reason: 'This endpoint uses a Cognito User Pool authorizer for authentication.' }]);
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaBackendStack/DataRetrievalApi/Default/call/start/POST/Resource', [{ id: 'AwsSolutions-COG4', reason: 'This endpoint uses a Cognito User Pool authorizer for authentication.' }]);
        // ========================================
        // CloudFormation Outputs (NO EXPORTS)
        // ========================================
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
        new cdk.CfnOutput(this, 'UserPoolId', {
            value: this.cognitoUserPool.userPoolId,
            description: 'Cognito User Pool ID',
        });
        new cdk.CfnOutput(this, 'UserPoolClientId', {
            value: this.cognitoUserPoolClient.userPoolClientId,
            description: 'Cognito User Pool Client ID',
        });
        new cdk.CfnOutput(this, 'DataRetrievalApiId', {
            value: this.dataRetrievalApi.restApiId,
            description: 'Private API Gateway ID for data retrieval',
        });
        new cdk.CfnOutput(this, 'DataRetrievalApiEndpoint', {
            value: this.dataRetrievalApi.url,
            description: 'Private API Gateway endpoint for data retrieval',
        });
        new cdk.CfnOutput(this, 'DataRetrievalApiVpcEndpoint', {
            value: `https://${this.dataRetrievalApi.restApiId}-${props.apiGatewayVpcEndpoint.vpcEndpointId}.execute-api.${this.region}.amazonaws.com/prod/`,
            description: 'Private API Gateway endpoint with VPC endpoint ID (use this for nginx proxy)',
        });
        new cdk.CfnOutput(this, 'CreateUserCommand', {
            value: `./scripts/setup-test-user.sh <email> Analysts`,
            description: 'Command to create a new Cognito user',
        });
        // ========================================
        // CDK Nag Suppressions
        // ========================================
        // Suppress wildcard permissions for Lambda CloudWatch Logs
        // Lambda functions require wildcard permissions to create log groups and streams
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, [
            '/ScaBackendStack/TranscriptionProcessor/ServiceRole/DefaultPolicy/Resource',
            '/ScaBackendStack/AnalyticsProcessor/ServiceRole/DefaultPolicy/Resource',
            '/ScaBackendStack/DataRetrieval/ServiceRole/DefaultPolicy/Resource',
        ], [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Lambda functions require wildcard permissions for CloudWatch Logs. ' +
                    'The logs:CreateLogGroup, logs:CreateLogStream, and logs:PutLogEvents actions ' +
                    'require Resource: "*" as log group names are generated at runtime. ' +
                    'See: https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs.html',
                appliesTo: ['Resource::*'],
            },
            {
                id: 'AwsSolutions-IAM5',
                reason: 'SendDurableExecutionCallbackSuccess requires wildcard resource because the ' +
                    'eligibility-checker function name is dynamically generated by CDK and lives in a different stack. ' +
                    'See: https://docs.aws.amazon.com/lambda/latest/dg/invocation-durable.html',
                appliesTo: [{ regex: '/^Resource::arn:aws:lambda:.+:\\d{12}:function:\\*$/' }],
            },
        ]);
        // Suppress wildcard permissions for DynamoDB GSI access
        // DynamoDB table policies require wildcard for GSI access patterns
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, [
            '/ScaBackendStack/TranscriptionProcessor/ServiceRole/DefaultPolicy/Resource',
            '/ScaBackendStack/AnalyticsProcessor/ServiceRole/DefaultPolicy/Resource',
            '/ScaBackendStack/DataRetrieval/ServiceRole/DefaultPolicy/Resource',
        ], [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'DynamoDB table access requires wildcard for Global Secondary Index (GSI) operations. ' +
                    'The pattern <TableArn>/index/* is required to access all GSIs on the table. ' +
                    'See: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/iam-policy-specific-table-indexes.html',
                appliesTo: [
                    'Resource::<TranscriptionsTableE617CB71.Arn>/index/*',
                    'Resource::<AnalyticsTable0B3C8B0C.Arn>/index/*',
                ],
            },
        ]);
        // Suppress AWS managed policy usage for Lambda execution roles
        // These are standard AWS managed policies designed for Lambda functions
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, [
            '/ScaBackendStack/TranscriptionProcessor/ServiceRole/Resource',
            '/ScaBackendStack/DataRetrieval/ServiceRole/Resource',
        ], [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'AWSLambdaBasicExecutionRole is the AWS recommended managed policy for Lambda functions. ' +
                    'It provides minimal permissions for CloudWatch Logs access. ' +
                    'See: https://docs.aws.amazon.com/lambda/latest/dg/lambda-intro-execution-role.html',
                appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
            },
        ]);
        // Suppress AWS managed policy for Lambda Durable Execution
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaBackendStack/AnalyticsProcessor/ServiceRole/Resource', [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'AWSLambdaBasicDurableExecutionRolePolicy is required for Lambda Durable Execution. ' +
                    'This AWS managed policy provides necessary permissions for durable state management. ' +
                    'See: https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html',
                appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicDurableExecutionRolePolicy'],
            },
        ]);
        // Suppress Lambda runtime version check - Python 3.13 is the latest
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, [
            '/ScaBackendStack/TranscriptionProcessor/Resource',
            '/ScaBackendStack/AnalyticsProcessor/Resource',
            '/ScaBackendStack/DataRetrieval/Resource',
        ], [
            {
                id: 'AwsSolutions-L1',
                reason: 'Lambda functions are using Python 3.13, which is the latest available runtime version. ' +
                    'See: https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html',
            },
        ]);
        // Suppress API Gateway managed policy
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaBackendStack/ApiGatewayCloudWatchRole/Resource', [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'AmazonAPIGatewayPushToCloudWatchLogs is the AWS recommended managed policy for API Gateway logging. ' +
                    'See: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-logging.html',
                appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs'],
            },
        ]);
        // Suppress DLQ not having a DLQ - this IS the DLQ
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaBackendStack/DeadLetterQueue/Resource', [
            {
                id: 'AwsSolutions-SQS3',
                reason: 'This queue IS the Dead Letter Queue for Lambda functions. ' +
                    'DLQs themselves do not require a DLQ as they are the final destination for failed messages.',
            },
        ]);
        // Suppress Kinesis KMS key warning
        // Using AWS managed key (aws/kinesis) is cost-effective for this use case
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaBackendStack/TranscriptionStream/Resource', [
            {
                id: 'AwsSolutions-KDS3',
                reason: 'Using AWS managed key (aws/kinesis) for server-side encryption to optimize costs. ' +
                    'Customer Managed Keys incur additional costs that scale with consumers/producers. ' +
                    'For compliance requirements, consider using CMK.',
            },
        ]);
        // Suppress SQS SSL requirement
        // Adding SSL-only policy to DLQ
        const dlqPolicy = new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ['sqs:*'],
            resources: [this.deadLetterQueue.queueArn],
            conditions: {
                Bool: {
                    'aws:SecureTransport': 'false',
                },
            },
        });
        this.deadLetterQueue.addToResourcePolicy(dlqPolicy);
        // Suppress Cognito MFA warning
        // MFA is optional for this solution to simplify user experience
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaBackendStack/UserPool/Resource', [
            {
                id: 'AwsSolutions-COG2',
                reason: 'MFA is not required for this solution to simplify user experience. ' +
                    'For production deployments with sensitive data, enable MFA for additional security.',
            },
        ]);
        // Suppress Cognito Advanced Security Mode
        // Advanced security features require additional configuration and cost
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaBackendStack/UserPool/Resource', [
            {
                id: 'AwsSolutions-COG3',
                reason: 'Advanced Security Mode is not enabled to reduce costs for this solution. ' +
                    'For production deployments, enable ENFORCED mode for malicious sign-in detection.',
            },
        ]);
        // Suppress API Gateway request validation
        // Request validation is handled by Lambda function
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaBackendStack/DataRetrievalApi/Resource', [
            {
                id: 'AwsSolutions-APIG2',
                reason: 'Request validation is performed by the Lambda function backend. ' +
                    'The Lambda function validates all inputs before processing.',
            },
        ]);
        // Suppress API Gateway access logging
        // Access logging adds operational overhead for private API
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaBackendStack/DataRetrievalApi/DeploymentStage.prod/Resource', [
            {
                id: 'AwsSolutions-APIG1',
                reason: 'Access logging is not enabled for this private API to reduce operational overhead. ' +
                    'For production deployments, enable access logs for audit and troubleshooting.',
            },
        ]);
        // Suppress API Gateway WAF requirement
        // WAF is not needed for private API that is only accessible from VPC
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaBackendStack/DataRetrievalApi/DeploymentStage.prod/Resource', [
            {
                id: 'AwsSolutions-APIG3',
                reason: 'AWS WAF is not required for this private API. ' +
                    'The API is only accessible from within the VPC via VPC endpoint, not from the internet. ' +
                    'Network-level security is enforced through security groups and VPC endpoint policies.',
            },
        ]);
        // Suppress API Gateway authorization warnings
        // This is a private API with VPC endpoint policy enforcement
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, [
            '/ScaBackendStack/DataRetrievalApi/Default/ANY/Resource',
            '/ScaBackendStack/DataRetrievalApi/Default/{proxy+}/ANY/Resource',
        ], [
            {
                id: 'AwsSolutions-APIG4',
                reason: 'This is a private API accessible only from within the VPC via VPC endpoint. ' +
                    'Access is controlled by VPC endpoint policy that restricts to specific VPC endpoint. ' +
                    'Additional authorization can be added using Cognito or IAM if needed.',
            },
            {
                id: 'AwsSolutions-COG4',
                reason: 'This is a private API accessible only from within the VPC via VPC endpoint. ' +
                    'Access is controlled by VPC endpoint policy. ' +
                    'Cognito authorization is handled at the web application layer.',
            },
        ]);
    }
}
exports.ScaBackendStack = ScaBackendStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NhLWJhY2tlbmQtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9pbmZyYXN0cnVjdHVyZS9saWIvc2NhLWJhY2tlbmQtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLG1FQUFxRDtBQUNyRCxpRUFBbUQ7QUFDbkQseURBQTJDO0FBRTNDLGlFQUFtRDtBQUNuRCx5REFBMkM7QUFDM0MsK0RBQWlEO0FBQ2pELHlGQUEyRTtBQUMzRSx1RUFBeUQ7QUFFekQscUNBQTBDO0FBQzFDLDJDQUE2QjtBQUM3Qix1Q0FBeUI7QUFFekIsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLGFBQWEsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFPeEY7Ozs7Ozs7Ozs7Ozs7R0FhRztBQUNILE1BQWEsZUFBZ0IsU0FBUSxHQUFHLENBQUMsS0FBSztJQVM1QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTJCO1FBQ25FLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLHNFQUFzRTtRQUN0RSxNQUFNLHdCQUF3QixHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsMEJBQTBCLEVBQUU7WUFDOUUsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLDBCQUEwQixDQUFDO1lBQy9ELGVBQWUsRUFBRTtnQkFDZixHQUFHLENBQUMsYUFBYSxDQUFDLHdCQUF3QixDQUFDLG1EQUFtRCxDQUFDO2FBQ2hHO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsSUFBSSxVQUFVLENBQUMsVUFBVSxDQUFDLElBQUksRUFBRSxtQkFBbUIsRUFBRTtZQUNuRCxpQkFBaUIsRUFBRSx3QkFBd0IsQ0FBQyxPQUFPO1NBQ3BELENBQUMsQ0FBQztRQUVILDZDQUE2QztRQUM3QyxJQUFJLENBQUMsbUJBQW1CLEdBQUcsSUFBSSxPQUFPLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxxQkFBcUIsRUFBRTtZQUN6RSxVQUFVLEVBQUUsMEJBQTBCO1lBQ3RDLFVBQVUsRUFBRSxPQUFPLENBQUMsVUFBVSxDQUFDLFNBQVM7WUFDeEMsZUFBZSxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztZQUNyQyxhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPLEVBQUUsa0JBQWtCO1NBQzdELENBQUMsQ0FBQztRQUVILHVDQUF1QztRQUN2QyxJQUFJLENBQUMsZUFBZSxHQUFHLElBQUksR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7WUFDNUQsU0FBUyxFQUFFLHVCQUF1QjtZQUNsQyxlQUFlLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1lBQ3RDLGlCQUFpQixFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztTQUMzQyxDQUFDLENBQUM7UUFFSCx5REFBeUQ7UUFDekQsSUFBSSxDQUFDLG1CQUFtQixHQUFHLElBQUksUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUscUJBQXFCLEVBQUU7WUFDekUsU0FBUyxFQUFFLG9CQUFvQjtZQUMvQixZQUFZLEVBQUU7Z0JBQ1osSUFBSSxFQUFFLElBQUk7Z0JBQ1YsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTTthQUNwQztZQUNELE9BQU8sRUFBRTtnQkFDUCxJQUFJLEVBQUUsSUFBSTtnQkFDVixJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNO2FBQ3BDO1lBQ0QsV0FBVyxFQUFFLFFBQVEsQ0FBQyxXQUFXLENBQUMsZUFBZTtZQUNqRCxNQUFNLEVBQUUsUUFBUSxDQUFDLGNBQWMsQ0FBQyxrQkFBa0I7WUFDbEQsbUJBQW1CLEVBQUUsSUFBSTtZQUN6QixVQUFVLEVBQUUsUUFBUSxDQUFDLGVBQWUsQ0FBQyxPQUFPO1lBQzVDLGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU8sRUFBRSxrQkFBa0I7U0FDN0QsQ0FBQyxDQUFDO1FBRUgsdURBQXVEO1FBQ3ZELElBQUksQ0FBQyxtQkFBbUIsQ0FBQyx1QkFBdUIsQ0FBQztZQUMvQyxTQUFTLEVBQUUsTUFBTTtZQUNqQixZQUFZLEVBQUU7Z0JBQ1osSUFBSSxFQUFFLFFBQVE7Z0JBQ2QsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTTthQUNwQztZQUNELE9BQU8sRUFBRTtnQkFDUCxJQUFJLEVBQUUsUUFBUTtnQkFDZCxJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNO2FBQ3BDO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsNkNBQTZDO1FBQzdDLElBQUksQ0FBQyxjQUFjLEdBQUcsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtZQUMvRCxTQUFTLEVBQUUsZUFBZTtZQUMxQixZQUFZLEVBQUU7Z0JBQ1osSUFBSSxFQUFFLElBQUk7Z0JBQ1YsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTTthQUNwQztZQUNELE9BQU8sRUFBRTtnQkFDUCxJQUFJLEVBQUUsSUFBSTtnQkFDVixJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNO2FBQ3BDO1lBQ0QsV0FBVyxFQUFFLFFBQVEsQ0FBQyxXQUFXLENBQUMsZUFBZTtZQUNqRCxtQkFBbUIsRUFBRSxJQUFJO1lBQ3pCLFVBQVUsRUFBRSxRQUFRLENBQUMsZUFBZSxDQUFDLE9BQU87WUFDNUMsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTyxFQUFFLGtCQUFrQjtTQUM3RCxDQUFDLENBQUM7UUFFSCwwQ0FBMEM7UUFDMUMsTUFBTSw4QkFBOEIsR0FBRyxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLHdCQUF3QixFQUFFO1lBQ3pGLE9BQU8sRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLFdBQVc7WUFDbkMsT0FBTyxFQUFFLHdCQUF3QjtZQUNqQyxJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsdUNBQXVDLENBQUMsQ0FBQztZQUMxRixPQUFPLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO1lBQ2hDLFVBQVUsRUFBRSxHQUFHO1lBQ2YsTUFBTSxFQUFFO2dCQUNOLE1BQU0sQ0FBQyxZQUFZLENBQUMsbUJBQW1CLENBQ3JDLElBQUksRUFDSixpQkFBaUIsRUFDakIsa0JBQWtCLElBQUksQ0FBQyxNQUFNLG1EQUFtRCxNQUFNLENBQUMsZUFBZSxDQUFDLGFBQWEsV0FBVyxNQUFNLENBQUMsZUFBZSxDQUFDLE9BQU8sRUFBRSxDQUNoSzthQUNGO1lBQ0QsV0FBVyxFQUFFO2dCQUNYLG9CQUFvQixFQUFFLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxTQUFTO2dCQUN4RCxPQUFPLEVBQUUsSUFBSSxDQUFDLGVBQWUsQ0FBQyxRQUFRO2dCQUN0Qyx1QkFBdUIsRUFBRSx5QkFBeUI7Z0JBQ2xELDRCQUE0QixFQUFFLEtBQUs7Z0JBQ25DLFNBQVMsRUFBRSxNQUFNO2FBQ2xCO1lBQ0QsT0FBTyxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsTUFBTTtTQUMvQixDQUFDLENBQUM7UUFFSCwyQ0FBMkM7UUFDM0MsSUFBSSxDQUFDLG1CQUFtQixDQUFDLGtCQUFrQixDQUFDLDhCQUE4QixDQUFDLENBQUM7UUFDNUUsSUFBSSxDQUFDLGVBQWUsQ0FBQyxpQkFBaUIsQ0FBQyw4QkFBOEIsQ0FBQyxDQUFDO1FBRXZFLHFDQUFxQztRQUNyQyw4QkFBOEIsQ0FBQyxjQUFjLENBQzNDLElBQUksa0JBQWtCLENBQUMsa0JBQWtCLENBQUMsSUFBSSxDQUFDLG1CQUFtQixFQUFFO1lBQ2xFLGdCQUFnQixFQUFFLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxNQUFNO1lBQ2hELFNBQVMsRUFBRSxHQUFHO1lBQ2QsaUJBQWlCLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQzNDLGFBQWEsRUFBRSxDQUFDO1lBQ2hCLGtCQUFrQixFQUFFLElBQUk7WUFDeEIsdUJBQXVCLEVBQUUsSUFBSTtTQUM5QixDQUFDLENBQ0gsQ0FBQztRQUVGLHVDQUF1QztRQUN2QyxJQUFJLENBQUMsZUFBZSxHQUFHLElBQUksT0FBTyxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsVUFBVSxFQUFFO1lBQzVELFlBQVksRUFBRSxlQUFlO1lBQzdCLGlCQUFpQixFQUFFLElBQUk7WUFDdkIsYUFBYSxFQUFFO2dCQUNiLEtBQUssRUFBRSxJQUFJO2FBQ1o7WUFDRCxVQUFVLEVBQUU7Z0JBQ1YsS0FBSyxFQUFFLElBQUk7YUFDWjtZQUNELGNBQWMsRUFBRTtnQkFDZCxTQUFTLEVBQUUsQ0FBQztnQkFDWixnQkFBZ0IsRUFBRSxJQUFJO2dCQUN0QixnQkFBZ0IsRUFBRSxJQUFJO2dCQUN0QixhQUFhLEVBQUUsSUFBSTtnQkFDbkIsY0FBYyxFQUFFLElBQUk7YUFDckI7WUFDRCxlQUFlLEVBQUUsT0FBTyxDQUFDLGVBQWUsQ0FBQyxVQUFVO1lBQ25ELGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU8sRUFBRSxrQkFBa0I7U0FDN0QsQ0FBQyxDQUFDO1FBRUgseUJBQWUsQ0FBQyx1QkFBdUIsQ0FBQyxJQUFJLENBQUMsZUFBZSxFQUFFO1lBQzVELEVBQUUsRUFBRSxFQUFFLG1CQUFtQixFQUFFLE1BQU0sRUFBRSx3QkFBd0IsRUFBRTtTQUM5RCxDQUFDLENBQUM7UUFFSCwyQkFBMkI7UUFDM0IsSUFBSSxDQUFDLHFCQUFxQixHQUFHLElBQUksQ0FBQyxlQUFlLENBQUMsU0FBUyxDQUFDLGNBQWMsRUFBRTtZQUMxRSxrQkFBa0IsRUFBRSxvQkFBb0I7WUFDeEMsY0FBYyxFQUFFLEtBQUs7WUFDckIsU0FBUyxFQUFFO2dCQUNULE9BQU8sRUFBRSxJQUFJO2dCQUNiLFlBQVksRUFBRSxJQUFJO2FBQ25CO1lBQ0QsS0FBSyxFQUFFO2dCQUNMLEtBQUssRUFBRTtvQkFDTCxzQkFBc0IsRUFBRSxJQUFJO2lCQUM3QjtnQkFDRCxNQUFNLEVBQUUsQ0FBQyxPQUFPLENBQUMsVUFBVSxDQUFDLE1BQU0sRUFBRSxPQUFPLENBQUMsVUFBVSxDQUFDLEtBQUssRUFBRSxPQUFPLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQzthQUMxRjtTQUNGLENBQUMsQ0FBQztRQUVILHNCQUFzQjtRQUN0QixJQUFJLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFO1lBQ2pELFVBQVUsRUFBRSxJQUFJLENBQUMsZUFBZSxDQUFDLFVBQVU7WUFDM0MsU0FBUyxFQUFFLFVBQVU7WUFDckIsV0FBVyxFQUFFLGdFQUFnRTtZQUM3RSxVQUFVLEVBQUUsQ0FBQztTQUNkLENBQUMsQ0FBQztRQUVILElBQUksT0FBTyxDQUFDLGdCQUFnQixDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7WUFDL0MsVUFBVSxFQUFFLElBQUksQ0FBQyxlQUFlLENBQUMsVUFBVTtZQUMzQyxTQUFTLEVBQUUsZ0JBQWdCO1lBQzNCLFdBQVcsRUFBRSx3Q0FBd0M7WUFDckQsVUFBVSxFQUFFLENBQUM7U0FDZCxDQUFDLENBQUM7UUFFSCw2REFBNkQ7UUFDN0QsTUFBTSwwQkFBMEIsR0FBRyxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLG9CQUFvQixFQUFFO1lBQ2pGLE9BQU8sRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLFdBQVc7WUFDbkMsT0FBTyxFQUFFLHdCQUF3QjtZQUNqQyxJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsbUNBQW1DLENBQUMsQ0FBQztZQUN0RixXQUFXLEVBQUUscUNBQXFDLElBQUksSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLEVBQUU7WUFDNUUsT0FBTyxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxFQUFHLG9EQUFvRDtZQUN4RixVQUFVLEVBQUUsSUFBSTtZQUNoQixNQUFNLEVBQUU7Z0JBQ04sTUFBTSxDQUFDLFlBQVksQ0FBQyxtQkFBbUIsQ0FDckMsSUFBSSxFQUNKLDBCQUEwQixFQUMxQixrQkFBa0IsSUFBSSxDQUFDLE1BQU0sbURBQW1ELE1BQU0sQ0FBQyxlQUFlLENBQUMsYUFBYSxXQUFXLE1BQU0sQ0FBQyxlQUFlLENBQUMsT0FBTyxFQUFFLENBQ2hLO2FBQ0Y7WUFDRCxXQUFXLEVBQUU7Z0JBQ1gsb0JBQW9CLEVBQUUsSUFBSSxDQUFDLG1CQUFtQixDQUFDLFNBQVM7Z0JBQ3hELGVBQWUsRUFBRSxJQUFJLENBQUMsY0FBYyxDQUFDLFNBQVM7Z0JBQzlDLHVCQUF1QixFQUFFLHFCQUFxQjtnQkFDOUMsNEJBQTRCLEVBQUUsS0FBSztnQkFDbkMsU0FBUyxFQUFFLE1BQU07YUFDbEI7WUFDRCxPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxNQUFNO1lBQzlCLHVFQUF1RTtZQUN2RSxpRUFBaUU7WUFDakUsYUFBYSxFQUFFO2dCQUNiLGdCQUFnQixFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxFQUFHLHNEQUFzRDtnQkFDbkcsZUFBZSxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFRLG9DQUFvQzthQUNsRjtTQUNGLENBQUMsQ0FBQztRQUVILHNEQUFzRDtRQUN0RCxJQUFJLENBQUMsbUJBQW1CLENBQUMsYUFBYSxDQUFDLDBCQUEwQixDQUFDLENBQUM7UUFDbkUsSUFBSSxDQUFDLGNBQWMsQ0FBQyxrQkFBa0IsQ0FBQywwQkFBMEIsQ0FBQyxDQUFDO1FBRW5FLDZDQUE2QztRQUM3QywwQkFBMEIsQ0FBQyxlQUFlLENBQ3hDLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUN0QixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQ3hCLE9BQU8sRUFBRTtnQkFDUCxxQkFBcUI7Z0JBQ3JCLHVDQUF1QzthQUN4QztZQUNELFNBQVMsRUFBRSxDQUFDLEdBQUcsQ0FBQztTQUNqQixDQUFDLENBQ0gsQ0FBQztRQUVGLG9FQUFvRTtRQUNwRSwwQkFBMEIsQ0FBQyxlQUFlLENBQ3hDLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUN0QixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQ3hCLE9BQU8sRUFBRTtnQkFDUCxtQ0FBbUM7Z0JBQ25DLDJCQUEyQjthQUM1QjtZQUNELFNBQVMsRUFBRSxDQUFDLEdBQUcsQ0FBQztTQUNqQixDQUFDLENBQ0gsQ0FBQztRQUVGLHlFQUF5RTtRQUN6RSxNQUFNLHVCQUF1QixHQUFHLElBQUksTUFBTSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUseUJBQXlCLEVBQUU7WUFDaEYsU0FBUyxFQUFFLE1BQU07WUFDakIsT0FBTyxFQUFFLDBCQUEwQixDQUFDLGNBQWM7U0FDbkQsQ0FBQyxDQUFDO1FBRUgsMkZBQTJGO1FBQzNGLHVCQUF1QixDQUFDLGNBQWMsQ0FDcEMsSUFBSSxrQkFBa0IsQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsbUJBQW1CLEVBQUU7WUFDakUsZ0JBQWdCLEVBQUUsTUFBTSxDQUFDLGdCQUFnQixDQUFDLE1BQU07WUFDaEQsU0FBUyxFQUFFLEVBQUU7WUFDYixpQkFBaUIsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7WUFDMUMsYUFBYSxFQUFFLENBQUM7WUFDaEIsa0JBQWtCLEVBQUUsSUFBSTtZQUN4Qix1QkFBdUIsRUFBRSxJQUFJO1lBQzdCLE9BQU8sRUFBRTtnQkFDUCxNQUFNLENBQUMsY0FBYyxDQUFDLE1BQU0sQ0FBQztvQkFDM0IsU0FBUyxFQUFFLE1BQU0sQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQztpQkFDL0MsQ0FBQztnQkFDRixNQUFNLENBQUMsY0FBYyxDQUFDLE1BQU0sQ0FBQztvQkFDM0IsU0FBUyxFQUFFLE1BQU0sQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQztpQkFDL0MsQ0FBQzthQUNIO1NBQ0YsQ0FBQyxDQUNILENBQUM7UUFFRixpQ0FBaUM7UUFDakMsTUFBTSxxQkFBcUIsR0FBRyxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLGVBQWUsRUFBRTtZQUN2RSxPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXO1lBQ25DLE9BQU8sRUFBRSx3QkFBd0I7WUFDakMsSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLDhCQUE4QixDQUFDLEVBQUU7Z0JBQ2hGLFFBQVEsRUFBRTtvQkFDUixLQUFLLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUMsYUFBYTtvQkFDL0MsT0FBTyxFQUFFO3dCQUNQLE1BQU0sRUFBRSxJQUFJO3dCQUNaLDRFQUE0RTtxQkFDN0U7aUJBQ0Y7YUFDRixDQUFDO1lBQ0YsT0FBTyxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUNqQyxVQUFVLEVBQUUsR0FBRztZQUNmLE1BQU0sRUFBRTtnQkFDTixNQUFNLENBQUMsWUFBWSxDQUFDLG1CQUFtQixDQUNyQyxJQUFJLEVBQ0osOEJBQThCLEVBQzlCLGtCQUFrQixJQUFJLENBQUMsTUFBTSxtREFBbUQsTUFBTSxDQUFDLGVBQWUsQ0FBQyxhQUFhLFdBQVcsTUFBTSxDQUFDLGVBQWUsQ0FBQyxPQUFPLEVBQUUsQ0FDaEs7YUFDRjtZQUNELFdBQVcsRUFBRTtnQkFDWCxvQkFBb0IsRUFBRSxJQUFJLENBQUMsbUJBQW1CLENBQUMsU0FBUztnQkFDeEQsZUFBZSxFQUFFLElBQUksQ0FBQyxjQUFjLENBQUMsU0FBUztnQkFDOUMsdUJBQXVCLEVBQUUsZ0JBQWdCO2dCQUN6Qyw0QkFBNEIsRUFBRSxLQUFLO2dCQUNuQyxTQUFTLEVBQUUsTUFBTTthQUNsQjtZQUNELE9BQU8sRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLE1BQU07U0FDL0IsQ0FBQyxDQUFDO1FBRUgsc0RBQXNEO1FBQ3RELElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxhQUFhLENBQUMscUJBQXFCLENBQUMsQ0FBQztRQUM5RCxJQUFJLENBQUMsY0FBYyxDQUFDLGFBQWEsQ0FBQyxxQkFBcUIsQ0FBQyxDQUFDO1FBRXpELHNGQUFzRjtRQUN0RixxQkFBcUIsQ0FBQyxlQUFlLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQzVELE9BQU8sRUFBRSxDQUFDLDRDQUE0QyxDQUFDO1lBQ3ZELFNBQVMsRUFBRSxDQUFDLGtCQUFrQixJQUFJLENBQUMsTUFBTSxJQUFJLElBQUksQ0FBQyxPQUFPLGFBQWEsQ0FBQztTQUN4RSxDQUFDLENBQUMsQ0FBQztRQUVKLDBCQUEwQjtRQUMxQixJQUFJLENBQUMsZ0JBQWdCLEdBQUcsSUFBSSxVQUFVLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtZQUN2RSxXQUFXLEVBQUUsd0JBQXdCO1lBQ3JDLFdBQVcsRUFBRSwrREFBK0Q7WUFDNUUscUJBQXFCLEVBQUU7Z0JBQ3JCLEtBQUssRUFBRSxDQUFDLFVBQVUsQ0FBQyxZQUFZLENBQUMsT0FBTyxDQUFDO2dCQUN4QyxZQUFZLEVBQUUsQ0FBQyxLQUFLLENBQUMscUJBQXFCLENBQUM7YUFDNUM7WUFDRCxNQUFNLEVBQUUsSUFBSSxHQUFHLENBQUMsY0FBYyxDQUFDO2dCQUM3QixVQUFVLEVBQUU7b0JBQ1YsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO3dCQUN0QixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO3dCQUN4QixVQUFVLEVBQUUsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxZQUFZLEVBQUUsQ0FBQzt3QkFDcEMsT0FBTyxFQUFFLENBQUMsb0JBQW9CLENBQUM7d0JBQy9CLFNBQVMsRUFBRSxDQUFDLGdCQUFnQixDQUFDO3dCQUM3QixVQUFVLEVBQUU7NEJBQ1YsWUFBWSxFQUFFO2dDQUNaLGdCQUFnQixFQUFFLEtBQUssQ0FBQyxxQkFBcUIsQ0FBQyxhQUFhOzZCQUM1RDt5QkFDRjtxQkFDRixDQUFDO2lCQUNIO2FBQ0YsQ0FBQztZQUNGLGFBQWEsRUFBRTtnQkFDYixTQUFTLEVBQUUsTUFBTTtnQkFDakIsY0FBYyxFQUFFLElBQUk7Z0JBQ3BCLFlBQVksRUFBRSxVQUFVLENBQUMsa0JBQWtCLENBQUMsSUFBSTtnQkFDaEQsZ0JBQWdCLEVBQUUsSUFBSTtnQkFDdEIsY0FBYyxFQUFFLElBQUk7Z0JBQ3BCLDhFQUE4RTtnQkFDOUUsOEVBQThFO2dCQUM5RSxrRkFBa0Y7Z0JBQ2xGLFNBQVMsRUFBRTtvQkFDVCxXQUFXLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsdUJBQXVCLENBQUMsSUFBSSx3QkFBd0I7b0JBQ3pGLGFBQWEsRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyx5QkFBeUIsQ0FBQyxJQUFJLDBCQUEwQjtpQkFDaEc7YUFDRjtTQUNGLENBQUMsQ0FBQztRQUVILHlCQUF5QjtRQUN6QixNQUFNLHdCQUF3QixHQUFHLElBQUksVUFBVSxDQUFDLGlCQUFpQixDQUFDLHFCQUFxQixFQUFFO1lBQ3ZGLEtBQUssRUFBRSxJQUFJO1NBQ1osQ0FBQyxDQUFDO1FBRUgseUJBQXlCO1FBQ3pCLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssRUFBRSx3QkFBd0IsQ0FBQyxDQUFDO1FBQ3RFLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDO1lBQ2xDLGtCQUFrQixFQUFFLHdCQUF3QjtZQUM1QyxTQUFTLEVBQUUsSUFBSTtTQUNoQixDQUFDLENBQUM7UUFFSCwyQ0FBMkM7UUFDM0MsNERBQTREO1FBQzVELDJDQUEyQztRQUMzQyxpRkFBaUY7UUFDakYsaUZBQWlGO1FBQ2pGLHFGQUFxRjtRQUNyRixxRkFBcUY7UUFDckYscUZBQXFGO1FBQ3JGLHNGQUFzRjtRQUN0Riw2RUFBNkU7UUFDN0UsMENBQTBDO1FBQzFDLE1BQU0saUJBQWlCLEdBQUcsSUFBSSxVQUFVLENBQUMsMEJBQTBCLENBQUMsSUFBSSxFQUFFLG1CQUFtQixFQUFFO1lBQzdGLGdCQUFnQixFQUFFLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQztZQUN4QyxjQUFjLEVBQUUscUJBQXFCO1NBQ3RDLENBQUMsQ0FBQztRQUVILE1BQU0sd0JBQXdCLEdBQUcsQ0FBQyxZQUFvQixFQUFFLEVBQUUsQ0FDeEQsSUFBSSxVQUFVLENBQUMsV0FBVyxDQUFDO1lBQ3pCLElBQUksRUFBRSxVQUFVLENBQUMsZUFBZSxDQUFDLFNBQVM7WUFDMUMscUJBQXFCLEVBQUUsTUFBTTtZQUM3QixnRkFBZ0Y7WUFDaEYsR0FBRyxFQUFFLHNCQUFzQixJQUFJLENBQUMsTUFBTSxvREFBb0QsSUFBSSxDQUFDLE1BQU0sSUFBSSxJQUFJLENBQUMsT0FBTywrQkFBK0IsWUFBWSxlQUFlO1NBQ2hMLENBQUMsQ0FBQztRQUVMLE1BQU0sWUFBWSxHQUFHLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQ3BFLE1BQU0saUJBQWlCLEdBQUcsWUFBWSxDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUM1RCxpQkFBaUIsQ0FBQyxTQUFTLENBQUMsTUFBTSxFQUFFLHdCQUF3QixDQUFDLGFBQWEsQ0FBQyxFQUFFO1lBQzNFLFVBQVUsRUFBRSxpQkFBaUI7WUFDN0IsaUJBQWlCLEVBQUUsVUFBVSxDQUFDLGlCQUFpQixDQUFDLE9BQU87U0FDeEQsQ0FBQyxDQUFDO1FBRUgsTUFBTSxZQUFZLEdBQUcsSUFBSSxDQUFDLGdCQUFnQixDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDcEUsTUFBTSxpQkFBaUIsR0FBRyxZQUFZLENBQUMsV0FBVyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQzVELGlCQUFpQixDQUFDLFNBQVMsQ0FBQyxNQUFNLEVBQUUsd0JBQXdCLENBQUMsZUFBZSxDQUFDLEVBQUU7WUFDN0UsVUFBVSxFQUFFLGlCQUFpQjtZQUM3QixpQkFBaUIsRUFBRSxVQUFVLENBQUMsaUJBQWlCLENBQUMsT0FBTztTQUN4RCxDQUFDLENBQUM7UUFFSCxnRkFBZ0Y7UUFDaEYseUJBQWUsQ0FBQyw2QkFBNkIsQ0FDM0MsSUFBSSxFQUNKLG9FQUFvRSxFQUNwRSxDQUFDLEVBQUUsRUFBRSxFQUFFLG1CQUFtQixFQUFFLE1BQU0sRUFBRSx1RUFBdUUsRUFBRSxDQUFDLENBQy9HLENBQUM7UUFDRix5QkFBZSxDQUFDLDZCQUE2QixDQUMzQyxJQUFJLEVBQ0osb0VBQW9FLEVBQ3BFLENBQUMsRUFBRSxFQUFFLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSxFQUFFLHVFQUF1RSxFQUFFLENBQUMsQ0FDL0csQ0FBQztRQUVGLDJDQUEyQztRQUMzQyxzQ0FBc0M7UUFDdEMsMkNBQTJDO1FBRTNDLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUseUJBQXlCLEVBQUU7WUFDakQsS0FBSyxFQUFFLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxVQUFVO1lBQzFDLFdBQVcsRUFBRSxpREFBaUQ7U0FDL0QsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSx3QkFBd0IsRUFBRTtZQUNoRCxLQUFLLEVBQUUsSUFBSSxDQUFDLG1CQUFtQixDQUFDLFNBQVM7WUFDekMsV0FBVyxFQUFFLGdEQUFnRDtTQUM5RCxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHlCQUF5QixFQUFFO1lBQ2pELEtBQUssRUFBRSxJQUFJLENBQUMsbUJBQW1CLENBQUMsU0FBUztZQUN6QyxXQUFXLEVBQUUsd0NBQXdDO1NBQ3RELENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsb0JBQW9CLEVBQUU7WUFDNUMsS0FBSyxFQUFFLElBQUksQ0FBQyxjQUFjLENBQUMsU0FBUztZQUNwQyxXQUFXLEVBQUUsbUNBQW1DO1NBQ2pELENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsb0JBQW9CLEVBQUU7WUFDNUMsS0FBSyxFQUFFLElBQUksQ0FBQyxlQUFlLENBQUMsUUFBUTtZQUNwQyxXQUFXLEVBQUUsMkJBQTJCO1NBQ3pDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQ3BDLEtBQUssRUFBRSxJQUFJLENBQUMsZUFBZSxDQUFDLFVBQVU7WUFDdEMsV0FBVyxFQUFFLHNCQUFzQjtTQUNwQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGtCQUFrQixFQUFFO1lBQzFDLEtBQUssRUFBRSxJQUFJLENBQUMscUJBQXFCLENBQUMsZ0JBQWdCO1lBQ2xELFdBQVcsRUFBRSw2QkFBNkI7U0FDM0MsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxvQkFBb0IsRUFBRTtZQUM1QyxLQUFLLEVBQUUsSUFBSSxDQUFDLGdCQUFnQixDQUFDLFNBQVM7WUFDdEMsV0FBVyxFQUFFLDJDQUEyQztTQUN6RCxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLDBCQUEwQixFQUFFO1lBQ2xELEtBQUssRUFBRSxJQUFJLENBQUMsZ0JBQWdCLENBQUMsR0FBRztZQUNoQyxXQUFXLEVBQUUsaURBQWlEO1NBQy9ELENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsNkJBQTZCLEVBQUU7WUFDckQsS0FBSyxFQUFFLFdBQVcsSUFBSSxDQUFDLGdCQUFnQixDQUFDLFNBQVMsSUFBSSxLQUFLLENBQUMscUJBQXFCLENBQUMsYUFBYSxnQkFBZ0IsSUFBSSxDQUFDLE1BQU0sc0JBQXNCO1lBQy9JLFdBQVcsRUFBRSw4RUFBOEU7U0FDNUYsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxtQkFBbUIsRUFBRTtZQUMzQyxLQUFLLEVBQUUsK0NBQStDO1lBQ3RELFdBQVcsRUFBRSxzQ0FBc0M7U0FDcEQsQ0FBQyxDQUFDO1FBRUgsMkNBQTJDO1FBQzNDLHVCQUF1QjtRQUN2QiwyQ0FBMkM7UUFFM0MsMkRBQTJEO1FBQzNELGlGQUFpRjtRQUNqRix5QkFBZSxDQUFDLDZCQUE2QixDQUMzQyxJQUFJLEVBQ0o7WUFDRSw0RUFBNEU7WUFDNUUsd0VBQXdFO1lBQ3hFLG1FQUFtRTtTQUNwRSxFQUNEO1lBQ0U7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUFFLHFFQUFxRTtvQkFDckUsK0VBQStFO29CQUMvRSxxRUFBcUU7b0JBQ3JFLGtGQUFrRjtnQkFDMUYsU0FBUyxFQUFFLENBQUMsYUFBYSxDQUFDO2FBQzNCO1lBQ0Q7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUFFLDZFQUE2RTtvQkFDN0Usb0dBQW9HO29CQUNwRywyRUFBMkU7Z0JBQ25GLFNBQVMsRUFBRSxDQUFDLEVBQUUsS0FBSyxFQUFFLHNEQUFzRCxFQUFFLENBQUM7YUFDL0U7U0FDRixDQUNGLENBQUM7UUFFRix3REFBd0Q7UUFDeEQsbUVBQW1FO1FBQ25FLHlCQUFlLENBQUMsNkJBQTZCLENBQzNDLElBQUksRUFDSjtZQUNFLDRFQUE0RTtZQUM1RSx3RUFBd0U7WUFDeEUsbUVBQW1FO1NBQ3BFLEVBQ0Q7WUFDRTtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsdUZBQXVGO29CQUN2Riw4RUFBOEU7b0JBQzlFLDhHQUE4RztnQkFDdEgsU0FBUyxFQUFFO29CQUNULHFEQUFxRDtvQkFDckQsZ0RBQWdEO2lCQUNqRDthQUNGO1NBQ0YsQ0FDRixDQUFDO1FBRUYsK0RBQStEO1FBQy9ELHdFQUF3RTtRQUN4RSx5QkFBZSxDQUFDLDZCQUE2QixDQUMzQyxJQUFJLEVBQ0o7WUFDRSw4REFBOEQ7WUFDOUQscURBQXFEO1NBQ3RELEVBQ0Q7WUFDRTtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsMEZBQTBGO29CQUMxRiw4REFBOEQ7b0JBQzlELG9GQUFvRjtnQkFDNUYsU0FBUyxFQUFFLENBQUMsdUZBQXVGLENBQUM7YUFDckc7U0FDRixDQUNGLENBQUM7UUFFRiwyREFBMkQ7UUFDM0QseUJBQWUsQ0FBQyw2QkFBNkIsQ0FDM0MsSUFBSSxFQUNKLDBEQUEwRCxFQUMxRDtZQUNFO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSxxRkFBcUY7b0JBQ3JGLHVGQUF1RjtvQkFDdkYsMEVBQTBFO2dCQUNsRixTQUFTLEVBQUUsQ0FBQyxvR0FBb0csQ0FBQzthQUNsSDtTQUNGLENBQ0YsQ0FBQztRQUVGLG9FQUFvRTtRQUNwRSx5QkFBZSxDQUFDLDZCQUE2QixDQUMzQyxJQUFJLEVBQ0o7WUFDRSxrREFBa0Q7WUFDbEQsOENBQThDO1lBQzlDLHlDQUF5QztTQUMxQyxFQUNEO1lBQ0U7Z0JBQ0UsRUFBRSxFQUFFLGlCQUFpQjtnQkFDckIsTUFBTSxFQUFFLHlGQUF5RjtvQkFDekYsd0VBQXdFO2FBQ2pGO1NBQ0YsQ0FDRixDQUFDO1FBRUYsc0NBQXNDO1FBQ3RDLHlCQUFlLENBQUMsNkJBQTZCLENBQzNDLElBQUksRUFDSixvREFBb0QsRUFDcEQ7WUFDRTtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsc0dBQXNHO29CQUN0Ryx1RkFBdUY7Z0JBQy9GLFNBQVMsRUFBRSxDQUFDLGdHQUFnRyxDQUFDO2FBQzlHO1NBQ0YsQ0FDRixDQUFDO1FBRUYsa0RBQWtEO1FBQ2xELHlCQUFlLENBQUMsNkJBQTZCLENBQzNDLElBQUksRUFDSiwyQ0FBMkMsRUFDM0M7WUFDRTtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsNERBQTREO29CQUM1RCw2RkFBNkY7YUFDdEc7U0FDRixDQUNGLENBQUM7UUFFRixtQ0FBbUM7UUFDbkMsMEVBQTBFO1FBQzFFLHlCQUFlLENBQUMsNkJBQTZCLENBQzNDLElBQUksRUFDSiwrQ0FBK0MsRUFDL0M7WUFDRTtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsb0ZBQW9GO29CQUNwRixvRkFBb0Y7b0JBQ3BGLGtEQUFrRDthQUMzRDtTQUNGLENBQ0YsQ0FBQztRQUVGLCtCQUErQjtRQUMvQixnQ0FBZ0M7UUFDaEMsTUFBTSxTQUFTLEdBQUcsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQ3hDLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLElBQUk7WUFDdkIsVUFBVSxFQUFFLENBQUMsSUFBSSxHQUFHLENBQUMsWUFBWSxFQUFFLENBQUM7WUFDcEMsT0FBTyxFQUFFLENBQUMsT0FBTyxDQUFDO1lBQ2xCLFNBQVMsRUFBRSxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsUUFBUSxDQUFDO1lBQzFDLFVBQVUsRUFBRTtnQkFDVixJQUFJLEVBQUU7b0JBQ0oscUJBQXFCLEVBQUUsT0FBTztpQkFDL0I7YUFDRjtTQUNGLENBQUMsQ0FBQztRQUNILElBQUksQ0FBQyxlQUFlLENBQUMsbUJBQW1CLENBQUMsU0FBUyxDQUFDLENBQUM7UUFFcEQsK0JBQStCO1FBQy9CLGdFQUFnRTtRQUNoRSx5QkFBZSxDQUFDLDZCQUE2QixDQUMzQyxJQUFJLEVBQ0osb0NBQW9DLEVBQ3BDO1lBQ0U7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUFFLHFFQUFxRTtvQkFDckUscUZBQXFGO2FBQzlGO1NBQ0YsQ0FDRixDQUFDO1FBRUYsMENBQTBDO1FBQzFDLHVFQUF1RTtRQUN2RSx5QkFBZSxDQUFDLDZCQUE2QixDQUMzQyxJQUFJLEVBQ0osb0NBQW9DLEVBQ3BDO1lBQ0U7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUFFLDJFQUEyRTtvQkFDM0UsbUZBQW1GO2FBQzVGO1NBQ0YsQ0FDRixDQUFDO1FBRUYsMENBQTBDO1FBQzFDLG1EQUFtRDtRQUNuRCx5QkFBZSxDQUFDLDZCQUE2QixDQUMzQyxJQUFJLEVBQ0osNENBQTRDLEVBQzVDO1lBQ0U7Z0JBQ0UsRUFBRSxFQUFFLG9CQUFvQjtnQkFDeEIsTUFBTSxFQUFFLGtFQUFrRTtvQkFDbEUsNkRBQTZEO2FBQ3RFO1NBQ0YsQ0FDRixDQUFDO1FBRUYsc0NBQXNDO1FBQ3RDLDJEQUEyRDtRQUMzRCx5QkFBZSxDQUFDLDZCQUE2QixDQUMzQyxJQUFJLEVBQ0osaUVBQWlFLEVBQ2pFO1lBQ0U7Z0JBQ0UsRUFBRSxFQUFFLG9CQUFvQjtnQkFDeEIsTUFBTSxFQUFFLHFGQUFxRjtvQkFDckYsK0VBQStFO2FBQ3hGO1NBQ0YsQ0FDRixDQUFDO1FBRUYsdUNBQXVDO1FBQ3ZDLHFFQUFxRTtRQUNyRSx5QkFBZSxDQUFDLDZCQUE2QixDQUMzQyxJQUFJLEVBQ0osaUVBQWlFLEVBQ2pFO1lBQ0U7Z0JBQ0UsRUFBRSxFQUFFLG9CQUFvQjtnQkFDeEIsTUFBTSxFQUFFLGdEQUFnRDtvQkFDaEQsMEZBQTBGO29CQUMxRix1RkFBdUY7YUFDaEc7U0FDRixDQUNGLENBQUM7UUFFRiw4Q0FBOEM7UUFDOUMsNkRBQTZEO1FBQzdELHlCQUFlLENBQUMsNkJBQTZCLENBQzNDLElBQUksRUFDSjtZQUNFLHdEQUF3RDtZQUN4RCxpRUFBaUU7U0FDbEUsRUFDRDtZQUNFO2dCQUNFLEVBQUUsRUFBRSxvQkFBb0I7Z0JBQ3hCLE1BQU0sRUFBRSw4RUFBOEU7b0JBQzlFLHVGQUF1RjtvQkFDdkYsdUVBQXVFO2FBQ2hGO1lBQ0Q7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUFFLDhFQUE4RTtvQkFDOUUsK0NBQStDO29CQUMvQyxnRUFBZ0U7YUFDekU7U0FDRixDQUNGLENBQUM7SUFDSixDQUFDO0NBQ0Y7QUF4dEJELDBDQXd0QkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiJztcbmltcG9ydCAqIGFzIGtpbmVzaXMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWtpbmVzaXMnO1xuaW1wb3J0ICogYXMgc3FzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zcXMnO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgY29nbml0byBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY29nbml0byc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgKiBhcyBsYW1iZGFFdmVudFNvdXJjZXMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYS1ldmVudC1zb3VyY2VzJztcbmltcG9ydCAqIGFzIGFwaWdhdGV3YXkgZnJvbSAnYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXknO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBOYWdTdXBwcmVzc2lvbnMgfSBmcm9tICdjZGstbmFnJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgKiBhcyBmcyBmcm9tICdmcyc7XG5cbmNvbnN0IGNvbmZpZyA9IEpTT04ucGFyc2UoZnMucmVhZEZpbGVTeW5jKHBhdGguam9pbihfX2Rpcm5hbWUsICdjb25maWcuanNvbicpLCAndXRmOCcpKTtcblxuZXhwb3J0IGludGVyZmFjZSBTY2FCYWNrZW5kU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgdnBjOiBlYzIuSVZwYztcbiAgYXBpR2F0ZXdheVZwY0VuZHBvaW50OiBlYzIuSUludGVyZmFjZVZwY0VuZHBvaW50O1xufVxuXG4vKipcbiAqIFNjYUJhY2tlbmRTdGFjayAtIEJhY2tlbmQgc2VydmljZXMgZm9yIHRoZSBTQ0Egc29sdXRpb25cbiAqIFxuICogVGhpcyBzdGFjayBjb250YWluczpcbiAqIC0gS2luZXNpcyBTdHJlYW0gZm9yIHRyYW5zY3JpcHRpb24gaW5nZXN0aW9uXG4gKiAtIER5bmFtb0RCIHRhYmxlcyBmb3IgdHJhbnNjcmlwdGlvbnMgYW5kIGFuYWx5dGljc1xuICogLSBMYW1iZGEgZnVuY3Rpb25zIGZvciBwcm9jZXNzaW5nXG4gKiAtIFByaXZhdGUgQVBJIEdhdGV3YXkgZm9yIGRhdGEgcmV0cmlldmFsXG4gKiAtIENvZ25pdG8gVXNlciBQb29sIGZvciBhdXRoZW50aWNhdGlvblxuICogLSBTUVMgRGVhZCBMZXR0ZXIgUXVldWVcbiAqIFxuICogUmVzb3VyY2VzIGFyZSBleHBvc2VkIHZpYSBwdWJsaWMgcmVhZG9ubHkgcHJvcGVydGllcyBmb3IgdXNlIGJ5IG90aGVyIHN0YWNrcy5cbiAqIE5PIENsb3VkRm9ybWF0aW9uIGV4cG9ydHMgYXJlIHVzZWQgdG8gYXZvaWQgY3Jvc3Mtc3RhY2sgZGVwZW5kZW5jaWVzLlxuICovXG5leHBvcnQgY2xhc3MgU2NhQmFja2VuZFN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IHRyYW5zY3JpcHRpb25zVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgYW5hbHl0aWNzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgdHJhbnNjcmlwdGlvblN0cmVhbToga2luZXNpcy5TdHJlYW07XG4gIHB1YmxpYyByZWFkb25seSBkZWFkTGV0dGVyUXVldWU6IHNxcy5RdWV1ZTtcbiAgcHVibGljIHJlYWRvbmx5IGNvZ25pdG9Vc2VyUG9vbDogY29nbml0by5Vc2VyUG9vbDtcbiAgcHVibGljIHJlYWRvbmx5IGNvZ25pdG9Vc2VyUG9vbENsaWVudDogY29nbml0by5Vc2VyUG9vbENsaWVudDtcbiAgcHVibGljIHJlYWRvbmx5IGRhdGFSZXRyaWV2YWxBcGk6IGFwaWdhdGV3YXkuUmVzdEFwaTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogU2NhQmFja2VuZFN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBDbG91ZFdhdGNoIExvZ3Mgcm9sZSBmb3IgQVBJIEdhdGV3YXkgKGFjY291bnQtbGV2ZWwgc2V0dGluZylcbiAgICBjb25zdCBhcGlHYXRld2F5Q2xvdWRXYXRjaFJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ0FwaUdhdGV3YXlDbG91ZFdhdGNoUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdhcGlnYXRld2F5LmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIG1hbmFnZWRQb2xpY2llczogW1xuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoJ3NlcnZpY2Utcm9sZS9BbWF6b25BUElHYXRld2F5UHVzaFRvQ2xvdWRXYXRjaExvZ3MnKSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICBuZXcgYXBpZ2F0ZXdheS5DZm5BY2NvdW50KHRoaXMsICdBcGlHYXRld2F5QWNjb3VudCcsIHtcbiAgICAgIGNsb3VkV2F0Y2hSb2xlQXJuOiBhcGlHYXRld2F5Q2xvdWRXYXRjaFJvbGUucm9sZUFybixcbiAgICB9KTtcblxuICAgIC8vIEtpbmVzaXMgU3RyZWFtIGZvciB0cmFuc2NyaXB0aW9uIGluZ2VzdGlvblxuICAgIHRoaXMudHJhbnNjcmlwdGlvblN0cmVhbSA9IG5ldyBraW5lc2lzLlN0cmVhbSh0aGlzLCAnVHJhbnNjcmlwdGlvblN0cmVhbScsIHtcbiAgICAgIHN0cmVhbU5hbWU6ICdzY2EtdHJhbnNjcmlwdGlvbi1zdHJlYW0nLFxuICAgICAgc3RyZWFtTW9kZToga2luZXNpcy5TdHJlYW1Nb2RlLk9OX0RFTUFORCxcbiAgICAgIHJldGVudGlvblBlcmlvZDogY2RrLkR1cmF0aW9uLmRheXMoNyksXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLCAvLyBGb3IgZGV2ZWxvcG1lbnRcbiAgICB9KTtcblxuICAgIC8vIERlYWQgTGV0dGVyIFF1ZXVlIGZvciBlcnJvciBoYW5kbGluZ1xuICAgIHRoaXMuZGVhZExldHRlclF1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCAnRGVhZExldHRlclF1ZXVlJywge1xuICAgICAgcXVldWVOYW1lOiAnc2NhLWRlYWQtbGV0dGVyLXF1ZXVlJyxcbiAgICAgIHJldGVudGlvblBlcmlvZDogY2RrLkR1cmF0aW9uLmRheXMoMTQpLFxuICAgICAgdmlzaWJpbGl0eVRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgIH0pO1xuXG4gICAgLy8gRHluYW1vREIgdGFibGUgZm9yIHRyYW5zY3JpcHRpb25zIHdpdGggc3RyZWFtcyBlbmFibGVkXG4gICAgdGhpcy50cmFuc2NyaXB0aW9uc1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdUcmFuc2NyaXB0aW9uc1RhYmxlJywge1xuICAgICAgdGFibGVOYW1lOiAnc2NhLXRyYW5zY3JpcHRpb25zJyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnUEsnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6ICdTSycsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICBzdHJlYW06IGR5bmFtb2RiLlN0cmVhbVZpZXdUeXBlLk5FV19BTkRfT0xEX0lNQUdFUyxcbiAgICAgIHBvaW50SW5UaW1lUmVjb3Zlcnk6IHRydWUsXG4gICAgICBlbmNyeXB0aW9uOiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uREVGQVVMVCxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksIC8vIEZvciBkZXZlbG9wbWVudFxuICAgIH0pO1xuXG4gICAgLy8gR2xvYmFsIFNlY29uZGFyeSBJbmRleCBmb3IgYWRkaXRpb25hbCBxdWVyeSBwYXR0ZXJuc1xuICAgIHRoaXMudHJhbnNjcmlwdGlvbnNUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdHU0kxJyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnR1NJMVBLJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnR1NJMVNLJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gRHluYW1vREIgdGFibGUgZm9yIGFuYWx5dGljcyBhbmQgc3VtbWFyaWVzXG4gICAgdGhpcy5hbmFseXRpY3NUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCAnQW5hbHl0aWNzVGFibGUnLCB7XG4gICAgICB0YWJsZU5hbWU6ICdzY2EtYW5hbHl0aWNzJyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnUEsnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6ICdTSycsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICBwb2ludEluVGltZVJlY292ZXJ5OiB0cnVlLFxuICAgICAgZW5jcnlwdGlvbjogZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkRFRkFVTFQsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLCAvLyBGb3IgZGV2ZWxvcG1lbnRcbiAgICB9KTtcblxuICAgIC8vIFRyYW5zY3JpcHRpb24gUHJvY2Vzc29yIExhbWJkYSBGdW5jdGlvblxuICAgIGNvbnN0IHRyYW5zY3JpcHRpb25Qcm9jZXNzb3JGdW5jdGlvbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ1RyYW5zY3JpcHRpb25Qcm9jZXNzb3InLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMyxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyLmxhbWJkYV9oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vLi4vYmFja2VuZC90cmFuc2NyaXB0aW9uLXByb2Nlc3NvcicpKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgbWVtb3J5U2l6ZTogNTEyLFxuICAgICAgbGF5ZXJzOiBbXG4gICAgICAgIGxhbWJkYS5MYXllclZlcnNpb24uZnJvbUxheWVyVmVyc2lvbkFybihcbiAgICAgICAgICB0aGlzLFxuICAgICAgICAgICdQb3dlcnRvb2xzTGF5ZXInLFxuICAgICAgICAgIGBhcm46YXdzOmxhbWJkYToke3RoaXMucmVnaW9ufTowMTcwMDA4MDE0NDY6bGF5ZXI6QVdTTGFtYmRhUG93ZXJ0b29sc1B5dGhvblYzLSR7Y29uZmlnLnBvd2VydG9vbHNMYXllci5weXRob25WZXJzaW9ufS14ODZfNjQ6JHtjb25maWcucG93ZXJ0b29sc0xheWVyLnZlcnNpb259YFxuICAgICAgICApLFxuICAgICAgXSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFRSQU5TQ1JJUFRJT05TX1RBQkxFOiB0aGlzLnRyYW5zY3JpcHRpb25zVGFibGUudGFibGVOYW1lLFxuICAgICAgICBETFFfVVJMOiB0aGlzLmRlYWRMZXR0ZXJRdWV1ZS5xdWV1ZVVybCxcbiAgICAgICAgUE9XRVJUT09MU19TRVJWSUNFX05BTUU6ICd0cmFuc2NyaXB0aW9uLXByb2Nlc3NvcicsXG4gICAgICAgIFBPV0VSVE9PTFNfTUVUUklDU19OQU1FU1BBQ0U6ICdTQ0EnLFxuICAgICAgICBMT0dfTEVWRUw6ICdJTkZPJyxcbiAgICAgIH0sXG4gICAgICB0cmFjaW5nOiBsYW1iZGEuVHJhY2luZy5BQ1RJVkUsXG4gICAgfSk7XG5cbiAgICAvLyBHcmFudCBwZXJtaXNzaW9ucyB0byB0aGUgTGFtYmRhIGZ1bmN0aW9uXG4gICAgdGhpcy50cmFuc2NyaXB0aW9uc1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YSh0cmFuc2NyaXB0aW9uUHJvY2Vzc29yRnVuY3Rpb24pO1xuICAgIHRoaXMuZGVhZExldHRlclF1ZXVlLmdyYW50U2VuZE1lc3NhZ2VzKHRyYW5zY3JpcHRpb25Qcm9jZXNzb3JGdW5jdGlvbik7XG5cbiAgICAvLyBBZGQgS2luZXNpcyBldmVudCBzb3VyY2UgdG8gTGFtYmRhXG4gICAgdHJhbnNjcmlwdGlvblByb2Nlc3NvckZ1bmN0aW9uLmFkZEV2ZW50U291cmNlKFxuICAgICAgbmV3IGxhbWJkYUV2ZW50U291cmNlcy5LaW5lc2lzRXZlbnRTb3VyY2UodGhpcy50cmFuc2NyaXB0aW9uU3RyZWFtLCB7XG4gICAgICAgIHN0YXJ0aW5nUG9zaXRpb246IGxhbWJkYS5TdGFydGluZ1Bvc2l0aW9uLkxBVEVTVCxcbiAgICAgICAgYmF0Y2hTaXplOiAxMDAsXG4gICAgICAgIG1heEJhdGNoaW5nV2luZG93OiBjZGsuRHVyYXRpb24uc2Vjb25kcygxMCksXG4gICAgICAgIHJldHJ5QXR0ZW1wdHM6IDMsXG4gICAgICAgIGJpc2VjdEJhdGNoT25FcnJvcjogdHJ1ZSxcbiAgICAgICAgcmVwb3J0QmF0Y2hJdGVtRmFpbHVyZXM6IHRydWUsXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLyBDb2duaXRvIFVzZXIgUG9vbCBmb3IgYXV0aGVudGljYXRpb25cbiAgICB0aGlzLmNvZ25pdG9Vc2VyUG9vbCA9IG5ldyBjb2duaXRvLlVzZXJQb29sKHRoaXMsICdVc2VyUG9vbCcsIHtcbiAgICAgIHVzZXJQb29sTmFtZTogJ3NjYS11c2VyLXBvb2wnLFxuICAgICAgc2VsZlNpZ25VcEVuYWJsZWQ6IHRydWUsXG4gICAgICBzaWduSW5BbGlhc2VzOiB7XG4gICAgICAgIGVtYWlsOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIGF1dG9WZXJpZnk6IHtcbiAgICAgICAgZW1haWw6IHRydWUsXG4gICAgICB9LFxuICAgICAgcGFzc3dvcmRQb2xpY3k6IHtcbiAgICAgICAgbWluTGVuZ3RoOiA4LFxuICAgICAgICByZXF1aXJlTG93ZXJjYXNlOiB0cnVlLFxuICAgICAgICByZXF1aXJlVXBwZXJjYXNlOiB0cnVlLFxuICAgICAgICByZXF1aXJlRGlnaXRzOiB0cnVlLFxuICAgICAgICByZXF1aXJlU3ltYm9sczogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICBhY2NvdW50UmVjb3Zlcnk6IGNvZ25pdG8uQWNjb3VudFJlY292ZXJ5LkVNQUlMX09OTFksXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLCAvLyBGb3IgZGV2ZWxvcG1lbnRcbiAgICB9KTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyh0aGlzLmNvZ25pdG9Vc2VyUG9vbCwgW1xuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1DT0c4JywgcmVhc29uOiAnUGx1cyB0aWVyIG5vdCByZXF1aXJlZCcgfSxcbiAgICBdKTtcblxuICAgIC8vIENvZ25pdG8gVXNlciBQb29sIENsaWVudFxuICAgIHRoaXMuY29nbml0b1VzZXJQb29sQ2xpZW50ID0gdGhpcy5jb2duaXRvVXNlclBvb2wuYWRkQ2xpZW50KCdXZWJBcHBDbGllbnQnLCB7XG4gICAgICB1c2VyUG9vbENsaWVudE5hbWU6ICdzY2Etd2ViLWFwcC1jbGllbnQnLFxuICAgICAgZ2VuZXJhdGVTZWNyZXQ6IGZhbHNlLFxuICAgICAgYXV0aEZsb3dzOiB7XG4gICAgICAgIHVzZXJTcnA6IHRydWUsXG4gICAgICAgIHVzZXJQYXNzd29yZDogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICBvQXV0aDoge1xuICAgICAgICBmbG93czoge1xuICAgICAgICAgIGF1dGhvcml6YXRpb25Db2RlR3JhbnQ6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIHNjb3BlczogW2NvZ25pdG8uT0F1dGhTY29wZS5PUEVOSUQsIGNvZ25pdG8uT0F1dGhTY29wZS5FTUFJTCwgY29nbml0by5PQXV0aFNjb3BlLlBST0ZJTEVdLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIENvZ25pdG8gVXNlciBHcm91cHNcbiAgICBuZXcgY29nbml0by5DZm5Vc2VyUG9vbEdyb3VwKHRoaXMsICdBbmFseXN0R3JvdXAnLCB7XG4gICAgICB1c2VyUG9vbElkOiB0aGlzLmNvZ25pdG9Vc2VyUG9vbC51c2VyUG9vbElkLFxuICAgICAgZ3JvdXBOYW1lOiAnQW5hbHlzdHMnLFxuICAgICAgZGVzY3JpcHRpb246ICdDb250YWN0IGNlbnRlciBhbmFseXN0cyB3aG8gY2FuIHZpZXcgYW5kIGFuYWx5emUgY29udmVyc2F0aW9ucycsXG4gICAgICBwcmVjZWRlbmNlOiAxLFxuICAgIH0pO1xuXG4gICAgbmV3IGNvZ25pdG8uQ2ZuVXNlclBvb2xHcm91cCh0aGlzLCAnQWRtaW5Hcm91cCcsIHtcbiAgICAgIHVzZXJQb29sSWQ6IHRoaXMuY29nbml0b1VzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICBncm91cE5hbWU6ICdBZG1pbmlzdHJhdG9ycycsXG4gICAgICBkZXNjcmlwdGlvbjogJ1N5c3RlbSBhZG1pbmlzdHJhdG9ycyB3aXRoIGZ1bGwgYWNjZXNzJyxcbiAgICAgIHByZWNlZGVuY2U6IDAsXG4gICAgfSk7XG5cbiAgICAvLyBBbmFseXRpY3MgUHJvY2Vzc29yIExhbWJkYSBGdW5jdGlvbiB3aXRoIER1cmFibGUgRXhlY3V0aW9uXG4gICAgY29uc3QgYW5hbHl0aWNzUHJvY2Vzc29yRnVuY3Rpb24gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdBbmFseXRpY3NQcm9jZXNzb3InLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMyxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyLmxhbWJkYV9oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vLi4vYmFja2VuZC9hbmFseXRpY3MtcHJvY2Vzc29yJykpLFxuICAgICAgZGVzY3JpcHRpb246IGBBbmFseXRpY3MgcHJvY2Vzc29yIC0gZGVwbG95ZWQgYXQgJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9YCxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDE1KSwgIC8vIE1heCB0aW1lb3V0IGZvciBMYW1iZGEgd2l0aCBldmVudCBzb3VyY2UgbWFwcGluZ3NcbiAgICAgIG1lbW9yeVNpemU6IDEwMjQsXG4gICAgICBsYXllcnM6IFtcbiAgICAgICAgbGFtYmRhLkxheWVyVmVyc2lvbi5mcm9tTGF5ZXJWZXJzaW9uQXJuKFxuICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgJ1Bvd2VydG9vbHNMYXllckFuYWx5dGljcycsXG4gICAgICAgICAgYGFybjphd3M6bGFtYmRhOiR7dGhpcy5yZWdpb259OjAxNzAwMDgwMTQ0NjpsYXllcjpBV1NMYW1iZGFQb3dlcnRvb2xzUHl0aG9uVjMtJHtjb25maWcucG93ZXJ0b29sc0xheWVyLnB5dGhvblZlcnNpb259LXg4Nl82NDoke2NvbmZpZy5wb3dlcnRvb2xzTGF5ZXIudmVyc2lvbn1gXG4gICAgICAgICksXG4gICAgICBdLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgVFJBTlNDUklQVElPTlNfVEFCTEU6IHRoaXMudHJhbnNjcmlwdGlvbnNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIEFOQUxZVElDU19UQUJMRTogdGhpcy5hbmFseXRpY3NUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIFBPV0VSVE9PTFNfU0VSVklDRV9OQU1FOiAnYW5hbHl0aWNzLXByb2Nlc3NvcicsXG4gICAgICAgIFBPV0VSVE9PTFNfTUVUUklDU19OQU1FU1BBQ0U6ICdTQ0EnLFxuICAgICAgICBMT0dfTEVWRUw6ICdJTkZPJyxcbiAgICAgIH0sXG4gICAgICB0cmFjaW5nOiBsYW1iZGEuVHJhY2luZy5BQ1RJVkUsXG4gICAgICAvLyBFbmFibGUgZHVyYWJsZSBleGVjdXRpb24gZm9yIHJlc2lsaWVudCBtdWx0aS1zdGVwIEJlZHJvY2sgcHJvY2Vzc2luZ1xuICAgICAgLy8gZXhlY3V0aW9uVGltZW91dCBtdXN0IGJlIOKJpDE1IG1pbnV0ZXMgZm9yIGV2ZW50IHNvdXJjZSBtYXBwaW5nc1xuICAgICAgZHVyYWJsZUNvbmZpZzoge1xuICAgICAgICBleGVjdXRpb25UaW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygxNSksICAvLyBNYXRjaCBMYW1iZGEgdGltZW91dCBmb3IgZXZlbnQgc291cmNlIGNvbXBhdGliaWxpdHlcbiAgICAgICAgcmV0ZW50aW9uUGVyaW9kOiBjZGsuRHVyYXRpb24uZGF5cyg3KSwgICAgICAgLy8gS2VlcCBleGVjdXRpb24gaGlzdG9yeSBmb3IgNyBkYXlzXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gR3JhbnQgcGVybWlzc2lvbnMgdG8gdGhlIEFuYWx5dGljcyBQcm9jZXNzb3IgTGFtYmRhXG4gICAgdGhpcy50cmFuc2NyaXB0aW9uc1RhYmxlLmdyYW50UmVhZERhdGEoYW5hbHl0aWNzUHJvY2Vzc29yRnVuY3Rpb24pO1xuICAgIHRoaXMuYW5hbHl0aWNzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGFuYWx5dGljc1Byb2Nlc3NvckZ1bmN0aW9uKTtcbiAgICBcbiAgICAvLyBHcmFudCBCZWRyb2NrIHBlcm1pc3Npb25zIGZvciBBSSBhbmFseXRpY3NcbiAgICBhbmFseXRpY3NQcm9jZXNzb3JGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICdiZWRyb2NrOkludm9rZU1vZGVsJyxcbiAgICAgICAgICAnYmVkcm9jazpJbnZva2VNb2RlbFdpdGhSZXNwb25zZVN0cmVhbScsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLyBHcmFudCBBV1MgTWFya2V0cGxhY2UgcGVybWlzc2lvbnMgZm9yIEJlZHJvY2sgbW9kZWwgc3Vic2NyaXB0aW9uc1xuICAgIGFuYWx5dGljc1Byb2Nlc3NvckZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgJ2F3cy1tYXJrZXRwbGFjZTpWaWV3U3Vic2NyaXB0aW9ucycsXG4gICAgICAgICAgJ2F3cy1tYXJrZXRwbGFjZTpTdWJzY3JpYmUnLFxuICAgICAgICBdLFxuICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gQ3JlYXRlIGFsaWFzIGZvciBkdXJhYmxlIGZ1bmN0aW9uIC0gcmVxdWlyZWQgZm9yIGV2ZW50IHNvdXJjZSBtYXBwaW5nc1xuICAgIGNvbnN0IGFuYWx5dGljc1Byb2Nlc3NvckFsaWFzID0gbmV3IGxhbWJkYS5BbGlhcyh0aGlzLCAnQW5hbHl0aWNzUHJvY2Vzc29yQWxpYXMnLCB7XG4gICAgICBhbGlhc05hbWU6ICdsaXZlJyxcbiAgICAgIHZlcnNpb246IGFuYWx5dGljc1Byb2Nlc3NvckZ1bmN0aW9uLmN1cnJlbnRWZXJzaW9uLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIER5bmFtb0RCIFN0cmVhbXMgZXZlbnQgc291cmNlIHRvIHRoZSBhbGlhcyAoZHVyYWJsZSBmdW5jdGlvbnMgcmVxdWlyZSBxdWFsaWZpZWQgQVJOKVxuICAgIGFuYWx5dGljc1Byb2Nlc3NvckFsaWFzLmFkZEV2ZW50U291cmNlKFxuICAgICAgbmV3IGxhbWJkYUV2ZW50U291cmNlcy5EeW5hbW9FdmVudFNvdXJjZSh0aGlzLnRyYW5zY3JpcHRpb25zVGFibGUsIHtcbiAgICAgICAgc3RhcnRpbmdQb3NpdGlvbjogbGFtYmRhLlN0YXJ0aW5nUG9zaXRpb24uTEFURVNULFxuICAgICAgICBiYXRjaFNpemU6IDEwLFxuICAgICAgICBtYXhCYXRjaGluZ1dpbmRvdzogY2RrLkR1cmF0aW9uLnNlY29uZHMoNSksXG4gICAgICAgIHJldHJ5QXR0ZW1wdHM6IDMsXG4gICAgICAgIGJpc2VjdEJhdGNoT25FcnJvcjogdHJ1ZSxcbiAgICAgICAgcmVwb3J0QmF0Y2hJdGVtRmFpbHVyZXM6IHRydWUsXG4gICAgICAgIGZpbHRlcnM6IFtcbiAgICAgICAgICBsYW1iZGEuRmlsdGVyQ3JpdGVyaWEuZmlsdGVyKHtcbiAgICAgICAgICAgIGV2ZW50TmFtZTogbGFtYmRhLkZpbHRlclJ1bGUuaXNFcXVhbCgnSU5TRVJUJyksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgbGFtYmRhLkZpbHRlckNyaXRlcmlhLmZpbHRlcih7XG4gICAgICAgICAgICBldmVudE5hbWU6IGxhbWJkYS5GaWx0ZXJSdWxlLmlzRXF1YWwoJ01PRElGWScpLFxuICAgICAgICAgIH0pLFxuICAgICAgICBdLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gRGF0YSBSZXRyaWV2YWwgTGFtYmRhIEZ1bmN0aW9uXG4gICAgY29uc3QgZGF0YVJldHJpZXZhbEZ1bmN0aW9uID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnRGF0YVJldHJpZXZhbCcsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzEzLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXIubGFtYmRhX2hhbmRsZXInLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi8uLi9iYWNrZW5kL2RhdGEtcmV0cmlldmFsJyksIHtcbiAgICAgICAgYnVuZGxpbmc6IHtcbiAgICAgICAgICBpbWFnZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTMuYnVuZGxpbmdJbWFnZSxcbiAgICAgICAgICBjb21tYW5kOiBbXG4gICAgICAgICAgICAnYmFzaCcsICctYycsXG4gICAgICAgICAgICAncGlwIGluc3RhbGwgLXIgcmVxdWlyZW1lbnRzLnR4dCAtdCAvYXNzZXQtb3V0cHV0ICYmIGNwIC1hdSAuIC9hc3NldC1vdXRwdXQnLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDUxMixcbiAgICAgIGxheWVyczogW1xuICAgICAgICBsYW1iZGEuTGF5ZXJWZXJzaW9uLmZyb21MYXllclZlcnNpb25Bcm4oXG4gICAgICAgICAgdGhpcyxcbiAgICAgICAgICAnUG93ZXJ0b29sc0xheWVyRGF0YVJldHJpZXZhbCcsXG4gICAgICAgICAgYGFybjphd3M6bGFtYmRhOiR7dGhpcy5yZWdpb259OjAxNzAwMDgwMTQ0NjpsYXllcjpBV1NMYW1iZGFQb3dlcnRvb2xzUHl0aG9uVjMtJHtjb25maWcucG93ZXJ0b29sc0xheWVyLnB5dGhvblZlcnNpb259LXg4Nl82NDoke2NvbmZpZy5wb3dlcnRvb2xzTGF5ZXIudmVyc2lvbn1gXG4gICAgICAgICksXG4gICAgICBdLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgVFJBTlNDUklQVElPTlNfVEFCTEU6IHRoaXMudHJhbnNjcmlwdGlvbnNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIEFOQUxZVElDU19UQUJMRTogdGhpcy5hbmFseXRpY3NUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIFBPV0VSVE9PTFNfU0VSVklDRV9OQU1FOiAnZGF0YS1yZXRyaWV2YWwnLFxuICAgICAgICBQT1dFUlRPT0xTX01FVFJJQ1NfTkFNRVNQQUNFOiAnU0NBJyxcbiAgICAgICAgTE9HX0xFVkVMOiAnSU5GTycsXG4gICAgICB9LFxuICAgICAgdHJhY2luZzogbGFtYmRhLlRyYWNpbmcuQUNUSVZFLFxuICAgIH0pO1xuXG4gICAgLy8gR3JhbnQgcmVhZCBwZXJtaXNzaW9ucyB0byB0aGUgRGF0YSBSZXRyaWV2YWwgTGFtYmRhXG4gICAgdGhpcy50cmFuc2NyaXB0aW9uc1RhYmxlLmdyYW50UmVhZERhdGEoZGF0YVJldHJpZXZhbEZ1bmN0aW9uKTtcbiAgICB0aGlzLmFuYWx5dGljc1RhYmxlLmdyYW50UmVhZERhdGEoZGF0YVJldHJpZXZhbEZ1bmN0aW9uKTtcblxuICAgIC8vIEFsbG93IGRhdGEtcmV0cmlldmFsIHRvIHNlbmQgZHVyYWJsZSBleGVjdXRpb24gY2FsbGJhY2tzIChMYWIgNTogc3VwZXJ2aXNvciByZXZpZXcpXG4gICAgZGF0YVJldHJpZXZhbEZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ2xhbWJkYTpTZW5kRHVyYWJsZUV4ZWN1dGlvbkNhbGxiYWNrU3VjY2VzcyddLFxuICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6bGFtYmRhOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpmdW5jdGlvbjoqYF0sXG4gICAgfSkpO1xuXG4gICAgLy8gQ3JlYXRlIHByaXZhdGUgUkVTVCBBUElcbiAgICB0aGlzLmRhdGFSZXRyaWV2YWxBcGkgPSBuZXcgYXBpZ2F0ZXdheS5SZXN0QXBpKHRoaXMsICdEYXRhUmV0cmlldmFsQXBpJywge1xuICAgICAgcmVzdEFwaU5hbWU6ICdzY2EtZGF0YS1yZXRyaWV2YWwtYXBpJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUHJpdmF0ZSBBUEkgZm9yIHF1ZXJ5aW5nIGNvbnRhY3QgdHJhbnNjcmlwdGlvbnMgYW5kIGFuYWx5dGljcycsXG4gICAgICBlbmRwb2ludENvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgdHlwZXM6IFthcGlnYXRld2F5LkVuZHBvaW50VHlwZS5QUklWQVRFXSxcbiAgICAgICAgdnBjRW5kcG9pbnRzOiBbcHJvcHMuYXBpR2F0ZXdheVZwY0VuZHBvaW50XSxcbiAgICAgIH0sXG4gICAgICBwb2xpY3k6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgcHJpbmNpcGFsczogW25ldyBpYW0uQW55UHJpbmNpcGFsKCldLFxuICAgICAgICAgICAgYWN0aW9uczogWydleGVjdXRlLWFwaTpJbnZva2UnXSxcbiAgICAgICAgICAgIHJlc291cmNlczogWydleGVjdXRlLWFwaTovKiddLFxuICAgICAgICAgICAgY29uZGl0aW9uczoge1xuICAgICAgICAgICAgICBTdHJpbmdFcXVhbHM6IHtcbiAgICAgICAgICAgICAgICAnYXdzOlNvdXJjZVZwY2UnOiBwcm9wcy5hcGlHYXRld2F5VnBjRW5kcG9pbnQudnBjRW5kcG9pbnRJZCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICB9KSxcbiAgICAgIGRlcGxveU9wdGlvbnM6IHtcbiAgICAgICAgc3RhZ2VOYW1lOiAncHJvZCcsXG4gICAgICAgIHRyYWNpbmdFbmFibGVkOiB0cnVlLFxuICAgICAgICBsb2dnaW5nTGV2ZWw6IGFwaWdhdGV3YXkuTWV0aG9kTG9nZ2luZ0xldmVsLklORk8sXG4gICAgICAgIGRhdGFUcmFjZUVuYWJsZWQ6IHRydWUsXG4gICAgICAgIG1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAvLyBTdGFnZSB2YXJpYWJsZXMgZGVjb3VwbGUgdGhlIEFQSSBmcm9tIHRoZSBjaGF0L3ZvaWNlIExhbWJkYXMgKHdoaWNoIGxpdmUgaW5cbiAgICAgICAgLy8gU2NhQWlTdGFjaykuIFRoZSBpbnRlZ3JhdGlvbiBVUklzIGJlbG93IHJlZmVyZW5jZSB0aGVzZSBieSBuYW1lLCBzbyB0aGUgQVBJXG4gICAgICAgIC8vIGNhbiBiZSBlZGl0ZWQvcmVkZXBsb3llZCBpbmRlcGVuZGVudGx5IG9mIHRoZSBMYW1iZGFzLiBOYW1lcyBjb21lIGZyb20gY29udGV4dC5cbiAgICAgICAgdmFyaWFibGVzOiB7XG4gICAgICAgICAgc3RhcnRDaGF0Rm46IHRoaXMubm9kZS50cnlHZXRDb250ZXh0KCdzdGFydENoYXRGdW5jdGlvbk5hbWUnKSA/PyAnc2NhLXN0YXJ0LWNoYXQtY29udGFjdCcsXG4gICAgICAgICAgc3RhcnRXZWJSdGNGbjogdGhpcy5ub2RlLnRyeUdldENvbnRleHQoJ3N0YXJ0V2ViUnRjRnVuY3Rpb25OYW1lJykgPz8gJ3NjYS1zdGFydC13ZWJydGMtY29udGFjdCcsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIExhbWJkYSBpbnRlZ3JhdGlvblxuICAgIGNvbnN0IGRhdGFSZXRyaWV2YWxJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5LkxhbWJkYUludGVncmF0aW9uKGRhdGFSZXRyaWV2YWxGdW5jdGlvbiwge1xuICAgICAgcHJveHk6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgQVBJIEdhdGV3YXkgcm91dGVzXG4gICAgdGhpcy5kYXRhUmV0cmlldmFsQXBpLnJvb3QuYWRkTWV0aG9kKCdBTlknLCBkYXRhUmV0cmlldmFsSW50ZWdyYXRpb24pO1xuICAgIHRoaXMuZGF0YVJldHJpZXZhbEFwaS5yb290LmFkZFByb3h5KHtcbiAgICAgIGRlZmF1bHRJbnRlZ3JhdGlvbjogZGF0YVJldHJpZXZhbEludGVncmF0aW9uLFxuICAgICAgYW55TWV0aG9kOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENvbm5lY3QgY2hhdC92b2ljZSByb3V0ZXMgKGRlY291cGxlZCB2aWEgc3RhZ2UgdmFyaWFibGVzKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyAvY2hhdC9zdGFydCBhbmQgL2NhbGwvc3RhcnQgYXJlIGludm9rZWQgYnkgYXV0aGVudGljYXRlZCBDUk0gdXNlcnMgdG8gc3RhcnQgYW5cbiAgICAvLyBpbi1hcHAgY2hhdCAoU3RhcnRDaGF0Q29udGFjdCkgb3IgYnJvd3NlciB2b2ljZSBjYWxsIChTdGFydFdlYlJUQ0NvbnRhY3QpLiBUaGVcbiAgICAvLyBiYWNraW5nIExhbWJkYXMgbGl2ZSBpbiBTY2FBaVN0YWNrIChkb3duc3RyZWFtIG9mIENvbm5lY3QpLiBUbyBhdm9pZCBhIGNyb3NzLXN0YWNrXG4gICAgLy8gQVJOIGltcG9ydCAvIGNpcmN1bGFyIGRlcGVuZGVuY3ksIHRoZSBpbnRlZ3JhdGlvbiBVUkkgcmVmZXJlbmNlcyB0aGUgdGFyZ2V0IExhbWJkYVxuICAgIC8vIGJ5IE5BTUUgdGhyb3VnaCBhbiBBUEkgR2F0ZXdheSBTVEFHRSBWQVJJQUJMRSAoc3RhcnRDaGF0Rm4gLyBzdGFydFdlYlJ0Y0ZuLCBzZXQgaW5cbiAgICAvLyBkZXBsb3lPcHRpb25zLnZhcmlhYmxlcyBhYm92ZSBmcm9tIGNkay5qc29uIGNvbnRleHQpLiBTY2FBaVN0YWNrIGdyYW50cyBBUEkgR2F0ZXdheVxuICAgIC8vIHBlcm1pc3Npb24gdG8gaW52b2tlIHRob3NlIGZ1bmN0aW9ucy4gVGhlIEFQSSBjYW4gdGhlcmVmb3JlIGJlIGNoYW5nZWQgYW5kXG4gICAgLy8gcmVkZXBsb3llZCB3aXRob3V0IHRvdWNoaW5nIFNjYUFpU3RhY2suXG4gICAgY29uc3QgY29nbml0b0F1dGhvcml6ZXIgPSBuZXcgYXBpZ2F0ZXdheS5Db2duaXRvVXNlclBvb2xzQXV0aG9yaXplcih0aGlzLCAnQ2hhdEFwaUF1dGhvcml6ZXInLCB7XG4gICAgICBjb2duaXRvVXNlclBvb2xzOiBbdGhpcy5jb2duaXRvVXNlclBvb2xdLFxuICAgICAgYXV0aG9yaXplck5hbWU6ICdzY2EtY2hhdC1hdXRob3JpemVyJyxcbiAgICB9KTtcblxuICAgIGNvbnN0IHN0YWdlVmFyUHJveHlJbnRlZ3JhdGlvbiA9IChzdGFnZVZhck5hbWU6IHN0cmluZykgPT5cbiAgICAgIG5ldyBhcGlnYXRld2F5LkludGVncmF0aW9uKHtcbiAgICAgICAgdHlwZTogYXBpZ2F0ZXdheS5JbnRlZ3JhdGlvblR5cGUuQVdTX1BST1hZLFxuICAgICAgICBpbnRlZ3JhdGlvbkh0dHBNZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgLy8gUmVmZXJlbmNlIHRoZSBMYW1iZGEgYnkgbmFtZSB2aWEgYSBzdGFnZSB2YXJpYWJsZSDigJQgbm8gY29uY3JldGUgQVJOIGF0IHN5bnRoLlxuICAgICAgICB1cmk6IGBhcm46YXdzOmFwaWdhdGV3YXk6JHt0aGlzLnJlZ2lvbn06bGFtYmRhOnBhdGgvMjAxNS0wMy0zMS9mdW5jdGlvbnMvYXJuOmF3czpsYW1iZGE6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OmZ1bmN0aW9uOiRcXHtzdGFnZVZhcmlhYmxlcy4ke3N0YWdlVmFyTmFtZX19L2ludm9jYXRpb25zYCxcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgY2hhdFJlc291cmNlID0gdGhpcy5kYXRhUmV0cmlldmFsQXBpLnJvb3QuYWRkUmVzb3VyY2UoJ2NoYXQnKTtcbiAgICBjb25zdCBjaGF0U3RhcnRSZXNvdXJjZSA9IGNoYXRSZXNvdXJjZS5hZGRSZXNvdXJjZSgnc3RhcnQnKTtcbiAgICBjaGF0U3RhcnRSZXNvdXJjZS5hZGRNZXRob2QoJ1BPU1QnLCBzdGFnZVZhclByb3h5SW50ZWdyYXRpb24oJ3N0YXJ0Q2hhdEZuJyksIHtcbiAgICAgIGF1dGhvcml6ZXI6IGNvZ25pdG9BdXRob3JpemVyLFxuICAgICAgYXV0aG9yaXphdGlvblR5cGU6IGFwaWdhdGV3YXkuQXV0aG9yaXphdGlvblR5cGUuQ09HTklUTyxcbiAgICB9KTtcblxuICAgIGNvbnN0IGNhbGxSZXNvdXJjZSA9IHRoaXMuZGF0YVJldHJpZXZhbEFwaS5yb290LmFkZFJlc291cmNlKCdjYWxsJyk7XG4gICAgY29uc3QgY2FsbFN0YXJ0UmVzb3VyY2UgPSBjYWxsUmVzb3VyY2UuYWRkUmVzb3VyY2UoJ3N0YXJ0Jyk7XG4gICAgY2FsbFN0YXJ0UmVzb3VyY2UuYWRkTWV0aG9kKCdQT1NUJywgc3RhZ2VWYXJQcm94eUludGVncmF0aW9uKCdzdGFydFdlYlJ0Y0ZuJyksIHtcbiAgICAgIGF1dGhvcml6ZXI6IGNvZ25pdG9BdXRob3JpemVyLFxuICAgICAgYXV0aG9yaXphdGlvblR5cGU6IGFwaWdhdGV3YXkuQXV0aG9yaXphdGlvblR5cGUuQ09HTklUTyxcbiAgICB9KTtcblxuICAgIC8vIFN1cHByZXNzIGF1dGggd2FybmluZ3Mgb24gdGhlIG5ldyBlbmRwb2ludHMgKHRoZXkgdXNlIHRoZSBDb2duaXRvIGF1dGhvcml6ZXIpXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zQnlQYXRoKFxuICAgICAgdGhpcyxcbiAgICAgICcvU2NhQmFja2VuZFN0YWNrL0RhdGFSZXRyaWV2YWxBcGkvRGVmYXVsdC9jaGF0L3N0YXJ0L1BPU1QvUmVzb3VyY2UnLFxuICAgICAgW3sgaWQ6ICdBd3NTb2x1dGlvbnMtQ09HNCcsIHJlYXNvbjogJ1RoaXMgZW5kcG9pbnQgdXNlcyBhIENvZ25pdG8gVXNlciBQb29sIGF1dGhvcml6ZXIgZm9yIGF1dGhlbnRpY2F0aW9uLicgfV1cbiAgICApO1xuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9uc0J5UGF0aChcbiAgICAgIHRoaXMsXG4gICAgICAnL1NjYUJhY2tlbmRTdGFjay9EYXRhUmV0cmlldmFsQXBpL0RlZmF1bHQvY2FsbC9zdGFydC9QT1NUL1Jlc291cmNlJyxcbiAgICAgIFt7IGlkOiAnQXdzU29sdXRpb25zLUNPRzQnLCByZWFzb246ICdUaGlzIGVuZHBvaW50IHVzZXMgYSBDb2duaXRvIFVzZXIgUG9vbCBhdXRob3JpemVyIGZvciBhdXRoZW50aWNhdGlvbi4nIH1dXG4gICAgKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDbG91ZEZvcm1hdGlvbiBPdXRwdXRzIChOTyBFWFBPUlRTKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVHJhbnNjcmlwdGlvblN0cmVhbU5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy50cmFuc2NyaXB0aW9uU3RyZWFtLnN0cmVhbU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0tpbmVzaXMgU3RyZWFtIG5hbWUgZm9yIHRyYW5zY3JpcHRpb24gaW5nZXN0aW9uJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUcmFuc2NyaXB0aW9uU3RyZWFtQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMudHJhbnNjcmlwdGlvblN0cmVhbS5zdHJlYW1Bcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0tpbmVzaXMgU3RyZWFtIEFSTiBmb3IgdHJhbnNjcmlwdGlvbiBpbmdlc3Rpb24nLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1RyYW5zY3JpcHRpb25zVGFibGVOYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMudHJhbnNjcmlwdGlvbnNUYWJsZS50YWJsZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0R5bmFtb0RCIHRhYmxlIG5hbWUgZm9yIHRyYW5zY3JpcHRpb25zJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBbmFseXRpY3NUYWJsZU5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5hbmFseXRpY3NUYWJsZS50YWJsZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0R5bmFtb0RCIHRhYmxlIG5hbWUgZm9yIGFuYWx5dGljcycsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRGVhZExldHRlclF1ZXVlVXJsJywge1xuICAgICAgdmFsdWU6IHRoaXMuZGVhZExldHRlclF1ZXVlLnF1ZXVlVXJsLFxuICAgICAgZGVzY3JpcHRpb246ICdTUVMgRGVhZCBMZXR0ZXIgUXVldWUgVVJMJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbElkJywge1xuICAgICAgdmFsdWU6IHRoaXMuY29nbml0b1VzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gVXNlciBQb29sIElEJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbENsaWVudElkJywge1xuICAgICAgdmFsdWU6IHRoaXMuY29nbml0b1VzZXJQb29sQ2xpZW50LnVzZXJQb29sQ2xpZW50SWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gVXNlciBQb29sIENsaWVudCBJRCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRGF0YVJldHJpZXZhbEFwaUlkJywge1xuICAgICAgdmFsdWU6IHRoaXMuZGF0YVJldHJpZXZhbEFwaS5yZXN0QXBpSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ1ByaXZhdGUgQVBJIEdhdGV3YXkgSUQgZm9yIGRhdGEgcmV0cmlldmFsJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYXRhUmV0cmlldmFsQXBpRW5kcG9pbnQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5kYXRhUmV0cmlldmFsQXBpLnVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUHJpdmF0ZSBBUEkgR2F0ZXdheSBlbmRwb2ludCBmb3IgZGF0YSByZXRyaWV2YWwnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RhdGFSZXRyaWV2YWxBcGlWcGNFbmRwb2ludCcsIHtcbiAgICAgIHZhbHVlOiBgaHR0cHM6Ly8ke3RoaXMuZGF0YVJldHJpZXZhbEFwaS5yZXN0QXBpSWR9LSR7cHJvcHMuYXBpR2F0ZXdheVZwY0VuZHBvaW50LnZwY0VuZHBvaW50SWR9LmV4ZWN1dGUtYXBpLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb20vcHJvZC9gLFxuICAgICAgZGVzY3JpcHRpb246ICdQcml2YXRlIEFQSSBHYXRld2F5IGVuZHBvaW50IHdpdGggVlBDIGVuZHBvaW50IElEICh1c2UgdGhpcyBmb3IgbmdpbnggcHJveHkpJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDcmVhdGVVc2VyQ29tbWFuZCcsIHtcbiAgICAgIHZhbHVlOiBgLi9zY3JpcHRzL3NldHVwLXRlc3QtdXNlci5zaCA8ZW1haWw+IEFuYWx5c3RzYCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29tbWFuZCB0byBjcmVhdGUgYSBuZXcgQ29nbml0byB1c2VyJyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDREsgTmFnIFN1cHByZXNzaW9uc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIFN1cHByZXNzIHdpbGRjYXJkIHBlcm1pc3Npb25zIGZvciBMYW1iZGEgQ2xvdWRXYXRjaCBMb2dzXG4gICAgLy8gTGFtYmRhIGZ1bmN0aW9ucyByZXF1aXJlIHdpbGRjYXJkIHBlcm1pc3Npb25zIHRvIGNyZWF0ZSBsb2cgZ3JvdXBzIGFuZCBzdHJlYW1zXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zQnlQYXRoKFxuICAgICAgdGhpcyxcbiAgICAgIFtcbiAgICAgICAgJy9TY2FCYWNrZW5kU3RhY2svVHJhbnNjcmlwdGlvblByb2Nlc3Nvci9TZXJ2aWNlUm9sZS9EZWZhdWx0UG9saWN5L1Jlc291cmNlJyxcbiAgICAgICAgJy9TY2FCYWNrZW5kU3RhY2svQW5hbHl0aWNzUHJvY2Vzc29yL1NlcnZpY2VSb2xlL0RlZmF1bHRQb2xpY3kvUmVzb3VyY2UnLFxuICAgICAgICAnL1NjYUJhY2tlbmRTdGFjay9EYXRhUmV0cmlldmFsL1NlcnZpY2VSb2xlL0RlZmF1bHRQb2xpY3kvUmVzb3VyY2UnLFxuICAgICAgXSxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLFxuICAgICAgICAgIHJlYXNvbjogJ0xhbWJkYSBmdW5jdGlvbnMgcmVxdWlyZSB3aWxkY2FyZCBwZXJtaXNzaW9ucyBmb3IgQ2xvdWRXYXRjaCBMb2dzLiAnICtcbiAgICAgICAgICAgICAgICAgICdUaGUgbG9nczpDcmVhdGVMb2dHcm91cCwgbG9nczpDcmVhdGVMb2dTdHJlYW0sIGFuZCBsb2dzOlB1dExvZ0V2ZW50cyBhY3Rpb25zICcgK1xuICAgICAgICAgICAgICAgICAgJ3JlcXVpcmUgUmVzb3VyY2U6IFwiKlwiIGFzIGxvZyBncm91cCBuYW1lcyBhcmUgZ2VuZXJhdGVkIGF0IHJ1bnRpbWUuICcgK1xuICAgICAgICAgICAgICAgICAgJ1NlZTogaHR0cHM6Ly9kb2NzLmF3cy5hbWF6b24uY29tL2xhbWJkYS9sYXRlc3QvZGcvbW9uaXRvcmluZy1jbG91ZHdhdGNobG9ncy5odG1sJyxcbiAgICAgICAgICBhcHBsaWVzVG86IFsnUmVzb3VyY2U6OionXSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLFxuICAgICAgICAgIHJlYXNvbjogJ1NlbmREdXJhYmxlRXhlY3V0aW9uQ2FsbGJhY2tTdWNjZXNzIHJlcXVpcmVzIHdpbGRjYXJkIHJlc291cmNlIGJlY2F1c2UgdGhlICcgK1xuICAgICAgICAgICAgICAgICAgJ2VsaWdpYmlsaXR5LWNoZWNrZXIgZnVuY3Rpb24gbmFtZSBpcyBkeW5hbWljYWxseSBnZW5lcmF0ZWQgYnkgQ0RLIGFuZCBsaXZlcyBpbiBhIGRpZmZlcmVudCBzdGFjay4gJyArXG4gICAgICAgICAgICAgICAgICAnU2VlOiBodHRwczovL2RvY3MuYXdzLmFtYXpvbi5jb20vbGFtYmRhL2xhdGVzdC9kZy9pbnZvY2F0aW9uLWR1cmFibGUuaHRtbCcsXG4gICAgICAgICAgYXBwbGllc1RvOiBbeyByZWdleDogJy9eUmVzb3VyY2U6OmFybjphd3M6bGFtYmRhOi4rOlxcXFxkezEyfTpmdW5jdGlvbjpcXFxcKiQvJyB9XSxcbiAgICAgICAgfSxcbiAgICAgIF1cbiAgICApO1xuXG4gICAgLy8gU3VwcHJlc3Mgd2lsZGNhcmQgcGVybWlzc2lvbnMgZm9yIER5bmFtb0RCIEdTSSBhY2Nlc3NcbiAgICAvLyBEeW5hbW9EQiB0YWJsZSBwb2xpY2llcyByZXF1aXJlIHdpbGRjYXJkIGZvciBHU0kgYWNjZXNzIHBhdHRlcm5zXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zQnlQYXRoKFxuICAgICAgdGhpcyxcbiAgICAgIFtcbiAgICAgICAgJy9TY2FCYWNrZW5kU3RhY2svVHJhbnNjcmlwdGlvblByb2Nlc3Nvci9TZXJ2aWNlUm9sZS9EZWZhdWx0UG9saWN5L1Jlc291cmNlJyxcbiAgICAgICAgJy9TY2FCYWNrZW5kU3RhY2svQW5hbHl0aWNzUHJvY2Vzc29yL1NlcnZpY2VSb2xlL0RlZmF1bHRQb2xpY3kvUmVzb3VyY2UnLFxuICAgICAgICAnL1NjYUJhY2tlbmRTdGFjay9EYXRhUmV0cmlldmFsL1NlcnZpY2VSb2xlL0RlZmF1bHRQb2xpY3kvUmVzb3VyY2UnLFxuICAgICAgXSxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLFxuICAgICAgICAgIHJlYXNvbjogJ0R5bmFtb0RCIHRhYmxlIGFjY2VzcyByZXF1aXJlcyB3aWxkY2FyZCBmb3IgR2xvYmFsIFNlY29uZGFyeSBJbmRleCAoR1NJKSBvcGVyYXRpb25zLiAnICtcbiAgICAgICAgICAgICAgICAgICdUaGUgcGF0dGVybiA8VGFibGVBcm4+L2luZGV4LyogaXMgcmVxdWlyZWQgdG8gYWNjZXNzIGFsbCBHU0lzIG9uIHRoZSB0YWJsZS4gJyArXG4gICAgICAgICAgICAgICAgICAnU2VlOiBodHRwczovL2RvY3MuYXdzLmFtYXpvbi5jb20vYW1hem9uZHluYW1vZGIvbGF0ZXN0L2RldmVsb3Blcmd1aWRlL2lhbS1wb2xpY3ktc3BlY2lmaWMtdGFibGUtaW5kZXhlcy5odG1sJyxcbiAgICAgICAgICBhcHBsaWVzVG86IFtcbiAgICAgICAgICAgICdSZXNvdXJjZTo6PFRyYW5zY3JpcHRpb25zVGFibGVFNjE3Q0I3MS5Bcm4+L2luZGV4LyonLFxuICAgICAgICAgICAgJ1Jlc291cmNlOjo8QW5hbHl0aWNzVGFibGUwQjNDOEIwQy5Bcm4+L2luZGV4LyonLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICBdXG4gICAgKTtcblxuICAgIC8vIFN1cHByZXNzIEFXUyBtYW5hZ2VkIHBvbGljeSB1c2FnZSBmb3IgTGFtYmRhIGV4ZWN1dGlvbiByb2xlc1xuICAgIC8vIFRoZXNlIGFyZSBzdGFuZGFyZCBBV1MgbWFuYWdlZCBwb2xpY2llcyBkZXNpZ25lZCBmb3IgTGFtYmRhIGZ1bmN0aW9uc1xuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9uc0J5UGF0aChcbiAgICAgIHRoaXMsXG4gICAgICBbXG4gICAgICAgICcvU2NhQmFja2VuZFN0YWNrL1RyYW5zY3JpcHRpb25Qcm9jZXNzb3IvU2VydmljZVJvbGUvUmVzb3VyY2UnLFxuICAgICAgICAnL1NjYUJhY2tlbmRTdGFjay9EYXRhUmV0cmlldmFsL1NlcnZpY2VSb2xlL1Jlc291cmNlJyxcbiAgICAgIF0sXG4gICAgICBbXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU00JyxcbiAgICAgICAgICByZWFzb246ICdBV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUgaXMgdGhlIEFXUyByZWNvbW1lbmRlZCBtYW5hZ2VkIHBvbGljeSBmb3IgTGFtYmRhIGZ1bmN0aW9ucy4gJyArXG4gICAgICAgICAgICAgICAgICAnSXQgcHJvdmlkZXMgbWluaW1hbCBwZXJtaXNzaW9ucyBmb3IgQ2xvdWRXYXRjaCBMb2dzIGFjY2Vzcy4gJyArXG4gICAgICAgICAgICAgICAgICAnU2VlOiBodHRwczovL2RvY3MuYXdzLmFtYXpvbi5jb20vbGFtYmRhL2xhdGVzdC9kZy9sYW1iZGEtaW50cm8tZXhlY3V0aW9uLXJvbGUuaHRtbCcsXG4gICAgICAgICAgYXBwbGllc1RvOiBbJ1BvbGljeTo6YXJuOjxBV1M6OlBhcnRpdGlvbj46aWFtOjphd3M6cG9saWN5L3NlcnZpY2Utcm9sZS9BV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUnXSxcbiAgICAgICAgfSxcbiAgICAgIF1cbiAgICApO1xuXG4gICAgLy8gU3VwcHJlc3MgQVdTIG1hbmFnZWQgcG9saWN5IGZvciBMYW1iZGEgRHVyYWJsZSBFeGVjdXRpb25cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnNCeVBhdGgoXG4gICAgICB0aGlzLFxuICAgICAgJy9TY2FCYWNrZW5kU3RhY2svQW5hbHl0aWNzUHJvY2Vzc29yL1NlcnZpY2VSb2xlL1Jlc291cmNlJyxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTQnLFxuICAgICAgICAgIHJlYXNvbjogJ0FXU0xhbWJkYUJhc2ljRHVyYWJsZUV4ZWN1dGlvblJvbGVQb2xpY3kgaXMgcmVxdWlyZWQgZm9yIExhbWJkYSBEdXJhYmxlIEV4ZWN1dGlvbi4gJyArXG4gICAgICAgICAgICAgICAgICAnVGhpcyBBV1MgbWFuYWdlZCBwb2xpY3kgcHJvdmlkZXMgbmVjZXNzYXJ5IHBlcm1pc3Npb25zIGZvciBkdXJhYmxlIHN0YXRlIG1hbmFnZW1lbnQuICcgK1xuICAgICAgICAgICAgICAgICAgJ1NlZTogaHR0cHM6Ly9kb2NzLmF3cy5hbWF6b24uY29tL2xhbWJkYS9sYXRlc3QvZGcvZHVyYWJsZS1mdW5jdGlvbnMuaHRtbCcsXG4gICAgICAgICAgYXBwbGllc1RvOiBbJ1BvbGljeTo6YXJuOjxBV1M6OlBhcnRpdGlvbj46aWFtOjphd3M6cG9saWN5L3NlcnZpY2Utcm9sZS9BV1NMYW1iZGFCYXNpY0R1cmFibGVFeGVjdXRpb25Sb2xlUG9saWN5J10sXG4gICAgICAgIH0sXG4gICAgICBdXG4gICAgKTtcblxuICAgIC8vIFN1cHByZXNzIExhbWJkYSBydW50aW1lIHZlcnNpb24gY2hlY2sgLSBQeXRob24gMy4xMyBpcyB0aGUgbGF0ZXN0XG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zQnlQYXRoKFxuICAgICAgdGhpcyxcbiAgICAgIFtcbiAgICAgICAgJy9TY2FCYWNrZW5kU3RhY2svVHJhbnNjcmlwdGlvblByb2Nlc3Nvci9SZXNvdXJjZScsXG4gICAgICAgICcvU2NhQmFja2VuZFN0YWNrL0FuYWx5dGljc1Byb2Nlc3Nvci9SZXNvdXJjZScsXG4gICAgICAgICcvU2NhQmFja2VuZFN0YWNrL0RhdGFSZXRyaWV2YWwvUmVzb3VyY2UnLFxuICAgICAgXSxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUwxJyxcbiAgICAgICAgICByZWFzb246ICdMYW1iZGEgZnVuY3Rpb25zIGFyZSB1c2luZyBQeXRob24gMy4xMywgd2hpY2ggaXMgdGhlIGxhdGVzdCBhdmFpbGFibGUgcnVudGltZSB2ZXJzaW9uLiAnICtcbiAgICAgICAgICAgICAgICAgICdTZWU6IGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9sYW1iZGEvbGF0ZXN0L2RnL2xhbWJkYS1ydW50aW1lcy5odG1sJyxcbiAgICAgICAgfSxcbiAgICAgIF1cbiAgICApO1xuXG4gICAgLy8gU3VwcHJlc3MgQVBJIEdhdGV3YXkgbWFuYWdlZCBwb2xpY3lcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnNCeVBhdGgoXG4gICAgICB0aGlzLFxuICAgICAgJy9TY2FCYWNrZW5kU3RhY2svQXBpR2F0ZXdheUNsb3VkV2F0Y2hSb2xlL1Jlc291cmNlJyxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTQnLFxuICAgICAgICAgIHJlYXNvbjogJ0FtYXpvbkFQSUdhdGV3YXlQdXNoVG9DbG91ZFdhdGNoTG9ncyBpcyB0aGUgQVdTIHJlY29tbWVuZGVkIG1hbmFnZWQgcG9saWN5IGZvciBBUEkgR2F0ZXdheSBsb2dnaW5nLiAnICtcbiAgICAgICAgICAgICAgICAgICdTZWU6IGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9hcGlnYXRld2F5L2xhdGVzdC9kZXZlbG9wZXJndWlkZS9zZXQtdXAtbG9nZ2luZy5odG1sJyxcbiAgICAgICAgICBhcHBsaWVzVG86IFsnUG9saWN5Ojphcm46PEFXUzo6UGFydGl0aW9uPjppYW06OmF3czpwb2xpY3kvc2VydmljZS1yb2xlL0FtYXpvbkFQSUdhdGV3YXlQdXNoVG9DbG91ZFdhdGNoTG9ncyddLFxuICAgICAgICB9LFxuICAgICAgXVxuICAgICk7XG5cbiAgICAvLyBTdXBwcmVzcyBETFEgbm90IGhhdmluZyBhIERMUSAtIHRoaXMgSVMgdGhlIERMUVxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9uc0J5UGF0aChcbiAgICAgIHRoaXMsXG4gICAgICAnL1NjYUJhY2tlbmRTdGFjay9EZWFkTGV0dGVyUXVldWUvUmVzb3VyY2UnLFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtU1FTMycsXG4gICAgICAgICAgcmVhc29uOiAnVGhpcyBxdWV1ZSBJUyB0aGUgRGVhZCBMZXR0ZXIgUXVldWUgZm9yIExhbWJkYSBmdW5jdGlvbnMuICcgK1xuICAgICAgICAgICAgICAgICAgJ0RMUXMgdGhlbXNlbHZlcyBkbyBub3QgcmVxdWlyZSBhIERMUSBhcyB0aGV5IGFyZSB0aGUgZmluYWwgZGVzdGluYXRpb24gZm9yIGZhaWxlZCBtZXNzYWdlcy4nLFxuICAgICAgICB9LFxuICAgICAgXVxuICAgICk7XG5cbiAgICAvLyBTdXBwcmVzcyBLaW5lc2lzIEtNUyBrZXkgd2FybmluZ1xuICAgIC8vIFVzaW5nIEFXUyBtYW5hZ2VkIGtleSAoYXdzL2tpbmVzaXMpIGlzIGNvc3QtZWZmZWN0aXZlIGZvciB0aGlzIHVzZSBjYXNlXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zQnlQYXRoKFxuICAgICAgdGhpcyxcbiAgICAgICcvU2NhQmFja2VuZFN0YWNrL1RyYW5zY3JpcHRpb25TdHJlYW0vUmVzb3VyY2UnLFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtS0RTMycsXG4gICAgICAgICAgcmVhc29uOiAnVXNpbmcgQVdTIG1hbmFnZWQga2V5IChhd3Mva2luZXNpcykgZm9yIHNlcnZlci1zaWRlIGVuY3J5cHRpb24gdG8gb3B0aW1pemUgY29zdHMuICcgK1xuICAgICAgICAgICAgICAgICAgJ0N1c3RvbWVyIE1hbmFnZWQgS2V5cyBpbmN1ciBhZGRpdGlvbmFsIGNvc3RzIHRoYXQgc2NhbGUgd2l0aCBjb25zdW1lcnMvcHJvZHVjZXJzLiAnICtcbiAgICAgICAgICAgICAgICAgICdGb3IgY29tcGxpYW5jZSByZXF1aXJlbWVudHMsIGNvbnNpZGVyIHVzaW5nIENNSy4nLFxuICAgICAgICB9LFxuICAgICAgXVxuICAgICk7XG5cbiAgICAvLyBTdXBwcmVzcyBTUVMgU1NMIHJlcXVpcmVtZW50XG4gICAgLy8gQWRkaW5nIFNTTC1vbmx5IHBvbGljeSB0byBETFFcbiAgICBjb25zdCBkbHFQb2xpY3kgPSBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuREVOWSxcbiAgICAgIHByaW5jaXBhbHM6IFtuZXcgaWFtLkFueVByaW5jaXBhbCgpXSxcbiAgICAgIGFjdGlvbnM6IFsnc3FzOionXSxcbiAgICAgIHJlc291cmNlczogW3RoaXMuZGVhZExldHRlclF1ZXVlLnF1ZXVlQXJuXSxcbiAgICAgIGNvbmRpdGlvbnM6IHtcbiAgICAgICAgQm9vbDoge1xuICAgICAgICAgICdhd3M6U2VjdXJlVHJhbnNwb3J0JzogJ2ZhbHNlJyxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgdGhpcy5kZWFkTGV0dGVyUXVldWUuYWRkVG9SZXNvdXJjZVBvbGljeShkbHFQb2xpY3kpO1xuXG4gICAgLy8gU3VwcHJlc3MgQ29nbml0byBNRkEgd2FybmluZ1xuICAgIC8vIE1GQSBpcyBvcHRpb25hbCBmb3IgdGhpcyBzb2x1dGlvbiB0byBzaW1wbGlmeSB1c2VyIGV4cGVyaWVuY2VcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnNCeVBhdGgoXG4gICAgICB0aGlzLFxuICAgICAgJy9TY2FCYWNrZW5kU3RhY2svVXNlclBvb2wvUmVzb3VyY2UnLFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtQ09HMicsXG4gICAgICAgICAgcmVhc29uOiAnTUZBIGlzIG5vdCByZXF1aXJlZCBmb3IgdGhpcyBzb2x1dGlvbiB0byBzaW1wbGlmeSB1c2VyIGV4cGVyaWVuY2UuICcgK1xuICAgICAgICAgICAgICAgICAgJ0ZvciBwcm9kdWN0aW9uIGRlcGxveW1lbnRzIHdpdGggc2Vuc2l0aXZlIGRhdGEsIGVuYWJsZSBNRkEgZm9yIGFkZGl0aW9uYWwgc2VjdXJpdHkuJyxcbiAgICAgICAgfSxcbiAgICAgIF1cbiAgICApO1xuXG4gICAgLy8gU3VwcHJlc3MgQ29nbml0byBBZHZhbmNlZCBTZWN1cml0eSBNb2RlXG4gICAgLy8gQWR2YW5jZWQgc2VjdXJpdHkgZmVhdHVyZXMgcmVxdWlyZSBhZGRpdGlvbmFsIGNvbmZpZ3VyYXRpb24gYW5kIGNvc3RcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnNCeVBhdGgoXG4gICAgICB0aGlzLFxuICAgICAgJy9TY2FCYWNrZW5kU3RhY2svVXNlclBvb2wvUmVzb3VyY2UnLFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtQ09HMycsXG4gICAgICAgICAgcmVhc29uOiAnQWR2YW5jZWQgU2VjdXJpdHkgTW9kZSBpcyBub3QgZW5hYmxlZCB0byByZWR1Y2UgY29zdHMgZm9yIHRoaXMgc29sdXRpb24uICcgK1xuICAgICAgICAgICAgICAgICAgJ0ZvciBwcm9kdWN0aW9uIGRlcGxveW1lbnRzLCBlbmFibGUgRU5GT1JDRUQgbW9kZSBmb3IgbWFsaWNpb3VzIHNpZ24taW4gZGV0ZWN0aW9uLicsXG4gICAgICAgIH0sXG4gICAgICBdXG4gICAgKTtcblxuICAgIC8vIFN1cHByZXNzIEFQSSBHYXRld2F5IHJlcXVlc3QgdmFsaWRhdGlvblxuICAgIC8vIFJlcXVlc3QgdmFsaWRhdGlvbiBpcyBoYW5kbGVkIGJ5IExhbWJkYSBmdW5jdGlvblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9uc0J5UGF0aChcbiAgICAgIHRoaXMsXG4gICAgICAnL1NjYUJhY2tlbmRTdGFjay9EYXRhUmV0cmlldmFsQXBpL1Jlc291cmNlJyxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUFQSUcyJyxcbiAgICAgICAgICByZWFzb246ICdSZXF1ZXN0IHZhbGlkYXRpb24gaXMgcGVyZm9ybWVkIGJ5IHRoZSBMYW1iZGEgZnVuY3Rpb24gYmFja2VuZC4gJyArXG4gICAgICAgICAgICAgICAgICAnVGhlIExhbWJkYSBmdW5jdGlvbiB2YWxpZGF0ZXMgYWxsIGlucHV0cyBiZWZvcmUgcHJvY2Vzc2luZy4nLFxuICAgICAgICB9LFxuICAgICAgXVxuICAgICk7XG5cbiAgICAvLyBTdXBwcmVzcyBBUEkgR2F0ZXdheSBhY2Nlc3MgbG9nZ2luZ1xuICAgIC8vIEFjY2VzcyBsb2dnaW5nIGFkZHMgb3BlcmF0aW9uYWwgb3ZlcmhlYWQgZm9yIHByaXZhdGUgQVBJXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zQnlQYXRoKFxuICAgICAgdGhpcyxcbiAgICAgICcvU2NhQmFja2VuZFN0YWNrL0RhdGFSZXRyaWV2YWxBcGkvRGVwbG95bWVudFN0YWdlLnByb2QvUmVzb3VyY2UnLFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtQVBJRzEnLFxuICAgICAgICAgIHJlYXNvbjogJ0FjY2VzcyBsb2dnaW5nIGlzIG5vdCBlbmFibGVkIGZvciB0aGlzIHByaXZhdGUgQVBJIHRvIHJlZHVjZSBvcGVyYXRpb25hbCBvdmVyaGVhZC4gJyArXG4gICAgICAgICAgICAgICAgICAnRm9yIHByb2R1Y3Rpb24gZGVwbG95bWVudHMsIGVuYWJsZSBhY2Nlc3MgbG9ncyBmb3IgYXVkaXQgYW5kIHRyb3VibGVzaG9vdGluZy4nLFxuICAgICAgICB9LFxuICAgICAgXVxuICAgICk7XG5cbiAgICAvLyBTdXBwcmVzcyBBUEkgR2F0ZXdheSBXQUYgcmVxdWlyZW1lbnRcbiAgICAvLyBXQUYgaXMgbm90IG5lZWRlZCBmb3IgcHJpdmF0ZSBBUEkgdGhhdCBpcyBvbmx5IGFjY2Vzc2libGUgZnJvbSBWUENcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnNCeVBhdGgoXG4gICAgICB0aGlzLFxuICAgICAgJy9TY2FCYWNrZW5kU3RhY2svRGF0YVJldHJpZXZhbEFwaS9EZXBsb3ltZW50U3RhZ2UucHJvZC9SZXNvdXJjZScsXG4gICAgICBbXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1BUElHMycsXG4gICAgICAgICAgcmVhc29uOiAnQVdTIFdBRiBpcyBub3QgcmVxdWlyZWQgZm9yIHRoaXMgcHJpdmF0ZSBBUEkuICcgK1xuICAgICAgICAgICAgICAgICAgJ1RoZSBBUEkgaXMgb25seSBhY2Nlc3NpYmxlIGZyb20gd2l0aGluIHRoZSBWUEMgdmlhIFZQQyBlbmRwb2ludCwgbm90IGZyb20gdGhlIGludGVybmV0LiAnICtcbiAgICAgICAgICAgICAgICAgICdOZXR3b3JrLWxldmVsIHNlY3VyaXR5IGlzIGVuZm9yY2VkIHRocm91Z2ggc2VjdXJpdHkgZ3JvdXBzIGFuZCBWUEMgZW5kcG9pbnQgcG9saWNpZXMuJyxcbiAgICAgICAgfSxcbiAgICAgIF1cbiAgICApO1xuXG4gICAgLy8gU3VwcHJlc3MgQVBJIEdhdGV3YXkgYXV0aG9yaXphdGlvbiB3YXJuaW5nc1xuICAgIC8vIFRoaXMgaXMgYSBwcml2YXRlIEFQSSB3aXRoIFZQQyBlbmRwb2ludCBwb2xpY3kgZW5mb3JjZW1lbnRcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnNCeVBhdGgoXG4gICAgICB0aGlzLFxuICAgICAgW1xuICAgICAgICAnL1NjYUJhY2tlbmRTdGFjay9EYXRhUmV0cmlldmFsQXBpL0RlZmF1bHQvQU5ZL1Jlc291cmNlJyxcbiAgICAgICAgJy9TY2FCYWNrZW5kU3RhY2svRGF0YVJldHJpZXZhbEFwaS9EZWZhdWx0L3twcm94eSt9L0FOWS9SZXNvdXJjZScsXG4gICAgICBdLFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtQVBJRzQnLFxuICAgICAgICAgIHJlYXNvbjogJ1RoaXMgaXMgYSBwcml2YXRlIEFQSSBhY2Nlc3NpYmxlIG9ubHkgZnJvbSB3aXRoaW4gdGhlIFZQQyB2aWEgVlBDIGVuZHBvaW50LiAnICtcbiAgICAgICAgICAgICAgICAgICdBY2Nlc3MgaXMgY29udHJvbGxlZCBieSBWUEMgZW5kcG9pbnQgcG9saWN5IHRoYXQgcmVzdHJpY3RzIHRvIHNwZWNpZmljIFZQQyBlbmRwb2ludC4gJyArXG4gICAgICAgICAgICAgICAgICAnQWRkaXRpb25hbCBhdXRob3JpemF0aW9uIGNhbiBiZSBhZGRlZCB1c2luZyBDb2duaXRvIG9yIElBTSBpZiBuZWVkZWQuJyxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUNPRzQnLFxuICAgICAgICAgIHJlYXNvbjogJ1RoaXMgaXMgYSBwcml2YXRlIEFQSSBhY2Nlc3NpYmxlIG9ubHkgZnJvbSB3aXRoaW4gdGhlIFZQQyB2aWEgVlBDIGVuZHBvaW50LiAnICtcbiAgICAgICAgICAgICAgICAgICdBY2Nlc3MgaXMgY29udHJvbGxlZCBieSBWUEMgZW5kcG9pbnQgcG9saWN5LiAnICtcbiAgICAgICAgICAgICAgICAgICdDb2duaXRvIGF1dGhvcml6YXRpb24gaXMgaGFuZGxlZCBhdCB0aGUgd2ViIGFwcGxpY2F0aW9uIGxheWVyLicsXG4gICAgICAgIH0sXG4gICAgICBdXG4gICAgKTtcbiAgfVxufVxuIl19