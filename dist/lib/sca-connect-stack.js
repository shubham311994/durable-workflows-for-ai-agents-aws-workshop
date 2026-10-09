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
exports.ScaConnectStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const connect = __importStar(require("aws-cdk-lib/aws-connect"));
const kinesis = __importStar(require("aws-cdk-lib/aws-kinesis"));
const secretsmanager = __importStar(require("aws-cdk-lib/aws-secretsmanager"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const cr = __importStar(require("aws-cdk-lib/custom-resources"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const cdk_nag_1 = require("cdk-nag");
class ScaConnectStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const streamName = props.transcriptionStreamName ?? 'sca-transcription-stream';
        // Import the Kinesis Stream
        const transcriptionStream = kinesis.Stream.fromStreamAttributes(this, 'ImportedTranscriptionStream', {
            streamArn: `arn:aws:kinesis:${this.region}:${this.account}:stream/${streamName}`,
        });
        // 1. Create Connect Instance with Contact Lens enabled
        this.connectInstance = new connect.CfnInstance(this, 'ConnectInstance', {
            identityManagementType: 'CONNECT_MANAGED',
            attributes: {
                inboundCalls: true,
                outboundCalls: true,
                contactLens: true,
                autoResolveBestVoices: true,
                contactflowLogs: true,
            },
            instanceAlias: `sca-connect-${cdk.Stack.of(this).account}`,
        });
        // Enable attributes not yet supported in CfnInstance.AttributesProperty
        for (const attrType of ['BOT_MANAGEMENT', 'ENABLE_BOT_ANALYTICS_AND_TRANSCRIPTS', 'AUTOMATED_INTERACTION_LOG']) {
            const res = new cr.AwsCustomResource(this, `Enable${attrType}`, {
                onCreate: {
                    service: 'Connect',
                    action: 'updateInstanceAttribute',
                    parameters: {
                        InstanceId: this.connectInstance.attrId,
                        AttributeType: attrType,
                        Value: 'true',
                    },
                    physicalResourceId: cr.PhysicalResourceId.of(`${attrType}-enabled`),
                },
                policy: cr.AwsCustomResourcePolicy.fromStatements([
                    new iam.PolicyStatement({
                        actions: ['connect:UpdateInstanceAttribute'],
                        resources: [this.connectInstance.attrArn],
                    }),
                    new iam.PolicyStatement({
                        actions: ['iam:PutRolePolicy'],
                        resources: ['*'],
                    }),
                    new iam.PolicyStatement({
                        actions: ['ds:DescribeDirectories'],
                        resources: ['*'],
                    }),
                ]),
            });
            res.node.addDependency(this.connectInstance);
        }
        // 2. Look up hours of operation
        const hoursOfOperationLookup = new cr.AwsCustomResource(this, 'HoursOfOperationLookup', {
            onCreate: {
                service: 'Connect',
                action: 'listHoursOfOperations',
                parameters: {
                    InstanceId: this.connectInstance.attrId,
                },
                physicalResourceId: cr.PhysicalResourceId.of('HoursOfOperationLookup'),
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
                resources: [this.connectInstance.attrArn],
            }),
        });
        const hoursOfOperationArn = hoursOfOperationLookup.getResponseField('HoursOfOperationSummaryList.0.Arn');
        // 3. Create queue for routing calls to agents
        const queue = new connect.CfnQueue(this, 'AgentQueue', {
            instanceArn: this.connectInstance.attrArn,
            name: 'SCA-Agent-Queue',
            description: 'Queue for routing calls to agents',
            hoursOfOperationArn: hoursOfOperationArn,
        });
        // 4. Create routing profile
        const agentRoutingProfile = new connect.CfnRoutingProfile(this, 'AgentRoutingProfile', {
            instanceArn: this.connectInstance.attrArn,
            name: 'SCA-Agent-Routing-Profile',
            description: 'Routing profile for agents to receive calls from SCA-Agent-Queue',
            defaultOutboundQueueArn: queue.attrQueueArn,
            mediaConcurrencies: [
                {
                    channel: 'VOICE',
                    concurrency: 1,
                },
            ],
            queueConfigs: [
                {
                    queueReference: {
                        channel: 'VOICE',
                        queueArn: queue.attrQueueArn,
                    },
                    priority: 1,
                    delay: 0,
                },
            ],
        });
        agentRoutingProfile.addDependency(queue);
        // 5. Provision Phone Number
        this.phoneNumber = new connect.CfnPhoneNumber(this, 'InboundPhoneNumber', {
            targetArn: this.connectInstance.attrArn,
            countryCode: 'US',
            type: 'TOLL_FREE',
            description: 'Phone number for SCA testing',
        });
        this.phoneNumber.addDependency(this.connectInstance);
        // 6. Generate admin password
        const adminPassword = new secretsmanager.Secret(this, 'AdminPassword', {
            generateSecretString: {
                excludePunctuation: true,
                excludeUppercase: false,
                includeSpace: false,
                passwordLength: 16,
                requireEachIncludedType: true,
            },
            description: 'Amazon Connect admin user password',
        });
        // 7. Look up security profiles
        const lookupProfilesFunction = new lambda.Function(this, 'LookupProfilesFunction', {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(2),
            code: lambda.Code.fromInline(`
import json
import boto3

connect = boto3.client('connect')

def handler(event, context):
    print(f"Event: {json.dumps(event)}")
    
    request_type = event['RequestType']
    instance_id = event['ResourceProperties']['InstanceId']
    
    if request_type == 'Delete':
        return {
            'PhysicalResourceId': f'profiles-lookup-{instance_id}',
            'Data': {}
        }
    
    try:
        security_profiles = connect.list_security_profiles(InstanceId=instance_id, MaxResults=50)
        admin_profile_arn = next(
            p['Arn'] for p in security_profiles['SecurityProfileSummaryList'] 
            if p['Name'] == 'Admin'
        )
        agent_profile_arn = next(
            p['Arn'] for p in security_profiles['SecurityProfileSummaryList'] 
            if p['Name'] == 'Agent'
        )
        
        return {
            'PhysicalResourceId': f'profiles-lookup-{instance_id}',
            'Data': {
                'AdminSecurityProfileArn': admin_profile_arn,
                'AgentSecurityProfileArn': agent_profile_arn
            }
        }
            
    except Exception as e:
        print(f"Error: {str(e)}")
        raise
`),
        });
        lookupProfilesFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: ['connect:ListSecurityProfiles'],
            resources: [this.connectInstance.attrArn],
        }));
        const lookupProfilesProvider = new cr.Provider(this, 'LookupProfilesProvider', {
            onEventHandler: lookupProfilesFunction,
        });
        const profilesLookup = new cdk.CustomResource(this, 'ProfilesLookup', {
            serviceToken: lookupProfilesProvider.serviceToken,
            properties: {
                InstanceId: this.connectInstance.attrId,
                Version: '2',
            },
        });
        profilesLookup.node.addDependency(this.connectInstance);
        // 8. Create admin user
        const adminUser = new connect.CfnUser(this, 'ConnectAdminUser', {
            instanceArn: this.connectInstance.attrArn,
            username: 'admin',
            password: adminPassword.secretValue.unsafeUnwrap(),
            identityInfo: {
                firstName: 'SCA',
                lastName: 'Admin',
                email: 'admin@example.com',
            },
            phoneConfig: {
                phoneType: 'SOFT_PHONE',
                autoAccept: false,
                afterContactWorkTimeLimit: 0,
            },
            routingProfileArn: agentRoutingProfile.attrRoutingProfileArn,
            securityProfileArns: [
                profilesLookup.getAttString('AdminSecurityProfileArn'),
                profilesLookup.getAttString('AgentSecurityProfileArn'),
            ],
        });
        adminUser.addDependency(this.connectInstance);
        adminUser.node.addDependency(profilesLookup);
        adminUser.node.addDependency(agentRoutingProfile);
        this.adminCredentials = adminPassword;
        // 9. Configure Contact Lens streaming
        const configureContactLensFunction = new lambda.Function(this, 'ConfigureContactLensFunction', {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(2),
            code: lambda.Code.fromInline(`
import json
import boto3

connect = boto3.client('connect')

def handler(event, context):
    print(f"Event: {json.dumps(event)}")
    
    request_type = event['RequestType']
    instance_id = event['ResourceProperties']['InstanceId']
    stream_arn = event['ResourceProperties']['StreamArn']
    
    physical_id = f'contact-lens-config-{instance_id}'
    
    try:
        if request_type == 'Create' or request_type == 'Update':
            try:
                configs = connect.list_instance_storage_configs(
                    InstanceId=instance_id,
                    ResourceType='REAL_TIME_CONTACT_ANALYSIS_VOICE_SEGMENTS'
                )
                
                if configs.get('StorageConfigs'):
                    print(f"Contact Lens already configured")
                    return {
                        'PhysicalResourceId': physical_id,
                        'Data': {'Status': 'AlreadyConfigured'}
                    }
            except Exception as e:
                print(f"No existing config: {e}")
            
            response = connect.associate_instance_storage_config(
                InstanceId=instance_id,
                ResourceType='REAL_TIME_CONTACT_ANALYSIS_VOICE_SEGMENTS',
                StorageConfig={
                    'StorageType': 'KINESIS_STREAM',
                    'KinesisStreamConfig': {
                        'StreamArn': stream_arn
                    }
                }
            )
            
            print(f"Contact Lens configured: {response}")
            
            return {
                'PhysicalResourceId': physical_id,
                'Data': {
                    'Status': 'Configured',
                    'AssociationId': response.get('AssociationId', '')
                }
            }
            
        elif request_type == 'Delete':
            try:
                configs = connect.list_instance_storage_configs(
                    InstanceId=instance_id,
                    ResourceType='REAL_TIME_CONTACT_ANALYSIS_VOICE_SEGMENTS'
                )
                
                for config in configs.get('StorageConfigs', []):
                    connect.disassociate_instance_storage_config(
                        InstanceId=instance_id,
                        AssociationId=config['AssociationId'],
                        ResourceType='REAL_TIME_CONTACT_ANALYSIS_VOICE_SEGMENTS'
                    )
            except Exception as e:
                print(f"Error during cleanup: {e}")
            
            return {
                'PhysicalResourceId': physical_id,
                'Data': {'Status': 'Deleted'}
            }
            
    except Exception as e:
        print(f"Error: {str(e)}")
        raise
`),
        });
        configureContactLensFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'connect:AssociateInstanceStorageConfig',
                'connect:DisassociateInstanceStorageConfig',
                'connect:ListInstanceStorageConfigs',
            ],
            resources: [this.connectInstance.attrArn],
        }));
        configureContactLensFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: ['kinesis:DescribeStream'],
            resources: [transcriptionStream.streamArn],
        }));
        configureContactLensFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: ['iam:PutRolePolicy'],
            resources: ['arn:aws:iam::*:role/aws-service-role/connect.amazonaws.com/AWSServiceRoleForAmazonConnect*'],
        }));
        const configureContactLensProvider = new cr.Provider(this, 'ConfigureContactLensProvider', {
            onEventHandler: configureContactLensFunction,
        });
        const contactLensConfig = new cdk.CustomResource(this, 'ContactLensConfig', {
            serviceToken: configureContactLensProvider.serviceToken,
            properties: {
                InstanceId: this.connectInstance.attrId,
                StreamArn: transcriptionStream.streamArn,
            },
        });
        contactLensConfig.node.addDependency(this.connectInstance);
        // 10. Configure Call Recording storage (required for Contact Lens transcriptions)
        const callRecordingBucket = new s3.Bucket(this, 'CallRecordingBucket', {
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });
        const callRecordingConfig = new cr.AwsCustomResource(this, 'CallRecordingConfig', {
            onCreate: {
                service: 'Connect',
                action: 'associateInstanceStorageConfig',
                parameters: {
                    InstanceId: this.connectInstance.attrId,
                    ResourceType: 'CALL_RECORDINGS',
                    StorageConfig: {
                        StorageType: 'S3',
                        S3Config: {
                            BucketName: callRecordingBucket.bucketName,
                            BucketPrefix: 'call-recordings',
                        },
                    },
                },
                physicalResourceId: cr.PhysicalResourceId.fromResponse('AssociationId'),
            },
            onDelete: {
                service: 'Connect',
                action: 'disassociateInstanceStorageConfig',
                parameters: {
                    InstanceId: this.connectInstance.attrId,
                    AssociationId: new cr.PhysicalResourceIdReference(),
                    ResourceType: 'CALL_RECORDINGS',
                },
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    actions: ['connect:AssociateInstanceStorageConfig', 'connect:DisassociateInstanceStorageConfig'],
                    resources: [this.connectInstance.attrArn],
                }),
                new iam.PolicyStatement({
                    actions: ['s3:GetBucketLocation', 's3:GetBucketAcl'],
                    resources: [callRecordingBucket.bucketArn],
                }),
                new iam.PolicyStatement({
                    actions: ['iam:PutRolePolicy'],
                    resources: ['*'],
                }),
                new iam.PolicyStatement({
                    actions: ['ds:DescribeDirectories'],
                    resources: ['*'],
                }),
            ]),
        });
        callRecordingConfig.node.addDependency(this.connectInstance);
        callRecordingConfig.node.addDependency(callRecordingBucket);
        // Outputs
        // 11. S3 Post-Call Analytics Processor — parses Contact Lens analysis files and writes to DynamoDB
        const s3AnalyticsProcessor = new lambda.Function(this, 'S3AnalyticsProcessor', {
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'handler.lambda_handler',
            code: lambda.Code.fromAsset('backend/s3-analytics-processor', {
                bundling: {
                    image: lambda.Runtime.PYTHON_3_13.bundlingImage,
                    command: ['bash', '-c', 'pip install -r requirements.txt -t /asset-output && cp -r . /asset-output'],
                },
            }),
            timeout: cdk.Duration.minutes(5),
            environment: {
                TRANSCRIPTIONS_TABLE: streamName.replace('transcription-stream', 'transcriptions'),
                POWERTOOLS_SERVICE_NAME: 's3-analytics-processor',
                POWERTOOLS_METRICS_NAMESPACE: 'SCA',
                LOG_LEVEL: 'INFO',
            },
            tracing: lambda.Tracing.ACTIVE,
        });
        // Grant DynamoDB write access
        s3AnalyticsProcessor.addToRolePolicy(new iam.PolicyStatement({
            actions: ['dynamodb:PutItem', 'dynamodb:BatchWriteItem'],
            resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/sca-transcriptions`],
        }));
        // Grant S3 read access
        callRecordingBucket.grantRead(s3AnalyticsProcessor);
        // Trigger on Analysis JSON files
        const s3EventSource = new (require('aws-cdk-lib/aws-lambda-event-sources').S3EventSource)(callRecordingBucket, {
            events: [cdk.aws_s3.EventType.OBJECT_CREATED],
            filters: [{ prefix: 'Analysis/', suffix: '.json' }],
        });
        s3AnalyticsProcessor.addEventSource(s3EventSource);
        new cdk.CfnOutput(this, 'ConnectInstanceId', {
            value: this.connectInstance.attrId,
            description: 'Amazon Connect Instance ID',
        });
        new cdk.CfnOutput(this, 'ConnectInstanceArn', {
            value: this.connectInstance.attrArn,
            description: 'Amazon Connect Instance ARN',
        });
        new cdk.CfnOutput(this, 'QueueId', {
            value: queue.attrQueueArn.split('/').pop(),
            description: 'Queue ID',
        });
        new cdk.CfnOutput(this, 'PhoneNumber', {
            value: this.phoneNumber.attrAddress,
            description: 'Phone Number (E.164 format)',
        });
        new cdk.CfnOutput(this, 'PhoneNumberArn', {
            value: this.phoneNumber.attrPhoneNumberArn,
            description: 'Phone Number ARN',
        });
        new cdk.CfnOutput(this, 'ConnectLoginUrl', {
            value: `https://${this.connectInstance.instanceAlias}.my.connect.aws/connect/login`,
            description: 'Amazon Connect login URL',
        });
        new cdk.CfnOutput(this, 'GetCredentialsCommand', {
            value: `aws secretsmanager get-secret-value --secret-id ${adminPassword.secretArn} --query SecretString --output text`,
            description: 'Command to retrieve admin credentials',
        });
        // ========================================
        // CDK Nag Suppressions
        // ========================================
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'AWS managed policy AWSLambdaBasicExecutionRole is appropriate for Lambda functions. ' +
                    'This includes CDK custom resource Lambdas that are managed by the CDK framework.',
                appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
                    'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicDurableExecutionRolePolicy'],
            },
        ]);
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            {
                id: 'AwsSolutions-L1',
                reason: 'CDK custom resource Lambdas use runtimes managed by the CDK framework. ' +
                    'These are internal implementation details and will be updated when CDK updates.',
            },
        ]);
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            {
                id: 'AwsSolutions-S1',
                reason: 'Call recording bucket does not require access logging for this solution.',
            },
        ]);
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard permissions are required for CDK custom resource Lambdas to invoke target functions. ' +
                    'These are internal CDK framework resources with appropriate scoping.',
                appliesTo: [
                    `Resource::<LookupProfilesFunction${lookupProfilesFunction.node.addr}.Arn>:*`,
                    `Resource::<ConfigureContactLensFunction${configureContactLensFunction.node.addr}.Arn>:*`,
                    'Resource::arn:aws:iam::*:role/aws-service-role/connect.amazonaws.com/AWSServiceRoleForAmazonConnect*',
                    'Resource::*',
                ],
            },
        ]);
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaConnectStack/LookupProfilesProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource', [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard permission required by CDK Provider framework to invoke the custom resource handler function with versioning support.',
                appliesTo: ['Resource::<LookupProfilesFunction41F7F870.Arn>:*'],
            },
        ]);
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaConnectStack/ConfigureContactLensProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource', [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard permission required by CDK Provider framework to invoke the custom resource handler function with versioning support.',
                appliesTo: ['Resource::<ConfigureContactLensFunction7BDE4DF9.Arn>:*'],
            },
        ]);
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaConnectStack/AdminPassword/Resource', [
            {
                id: 'AwsSolutions-SMG4',
                reason: 'Admin password is a temporary credential for initial Amazon Connect setup. ' +
                    'It should be changed immediately after first login and is not used in production.',
            },
        ]);
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, `/${id}/S3AnalyticsProcessor/ServiceRole/DefaultPolicy/Resource`, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'S3 read permissions with wildcards are required by CDK grantRead() for reading analysis files from the call recording bucket.',
                appliesTo: [
                    'Action::s3:GetBucket*',
                    'Action::s3:GetObject*',
                    'Action::s3:List*',
                    'Resource::<CallRecordingBucketC145AC7F.Arn>/*',
                ],
            },
        ]);
    }
}
exports.ScaConnectStack = ScaConnectStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NhLWNvbm5lY3Qtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9pbmZyYXN0cnVjdHVyZS9saWIvc2NhLWNvbm5lY3Qtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLGlFQUFtRDtBQUNuRCxpRUFBbUQ7QUFFbkQsK0VBQWlFO0FBQ2pFLCtEQUFpRDtBQUNqRCx5REFBMkM7QUFDM0MsaUVBQW1EO0FBQ25ELHVEQUF5QztBQUV6QyxxQ0FBMEM7QUFlMUMsTUFBYSxlQUFnQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBSzVDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBMkI7UUFDbkUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsTUFBTSxVQUFVLEdBQUcsS0FBSyxDQUFDLHVCQUF1QixJQUFJLDBCQUEwQixDQUFDO1FBRS9FLDRCQUE0QjtRQUM1QixNQUFNLG1CQUFtQixHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsb0JBQW9CLENBQzdELElBQUksRUFDSiw2QkFBNkIsRUFDN0I7WUFDRSxTQUFTLEVBQUUsbUJBQW1CLElBQUksQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDLE9BQU8sV0FBVyxVQUFVLEVBQUU7U0FDakYsQ0FDRixDQUFDO1FBRUYsdURBQXVEO1FBQ3ZELElBQUksQ0FBQyxlQUFlLEdBQUcsSUFBSSxPQUFPLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSxpQkFBaUIsRUFBRTtZQUN0RSxzQkFBc0IsRUFBRSxpQkFBaUI7WUFDekMsVUFBVSxFQUFFO2dCQUNWLFlBQVksRUFBRSxJQUFJO2dCQUNsQixhQUFhLEVBQUUsSUFBSTtnQkFDbkIsV0FBVyxFQUFFLElBQUk7Z0JBQ2pCLHFCQUFxQixFQUFFLElBQUk7Z0JBQzNCLGVBQWUsRUFBRSxJQUFJO2FBQ3RCO1lB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WUFDRTtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsZ0lBQWdJO2dCQUN4SSxTQUFTLEVBQUUsQ0FBQyxrREFBa0QsQ0FBQzthQUNoRTtTQUNGLENBQ0YsQ0FBQztRQUVGLHlCQUFlLENBQUMsNkJBQTZCLENBQzNDLElBQUksRUFDSixvR0FBb0csRUFDcEc7WUFDRTtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsZ0lBQWdJO2dCQUN4SSxTQUFTLEVBQUUsQ0FBQyx3REFBd0QsQ0FBQzthQUN0RTtTQUNGLENBQ0YsQ0FBQztRQUVGLHlCQUFlLENBQUMsNkJBQTZCLENBQzNDLElBQUksRUFDSix5Q0FBeUMsRUFDekM7WUFDRTtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsNkVBQTZFO29CQUM3RSxtRkFBbUY7YUFDNUY7U0FDRixDQUNGLENBQUM7UUFDRix5QkFBZSxDQUFDLDZCQUE2QixDQUMzQyxJQUFJLEVBQ0osSUFBSSxFQUFFLDBEQUEwRCxFQUNoRTtZQUNFO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSwrSEFBK0g7Z0JBQ3ZJLFNBQVMsRUFBRTtvQkFDVCx1QkFBdUI7b0JBQ3ZCLHVCQUF1QjtvQkFDdkIsa0JBQWtCO29CQUNsQiwrQ0FBK0M7aUJBQ2hEO2FBQ0Y7U0FDRixDQUNGLENBQUM7SUFDSixDQUFDO0NBQ0Y7QUE5akJELDBDQThqQkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgY29ubmVjdCBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY29ubmVjdCc7XG5pbXBvcnQgKiBhcyBraW5lc2lzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1raW5lc2lzJztcbmltcG9ydCAqIGFzIGttcyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mta21zJztcbmltcG9ydCAqIGFzIHNlY3JldHNtYW5hZ2VyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zZWNyZXRzbWFuYWdlcic7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBjciBmcm9tICdhd3MtY2RrLWxpYi9jdXN0b20tcmVzb3VyY2VzJztcbmltcG9ydCAqIGFzIHMzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMyc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7IE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gJ2Nkay1uYWcnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFNjYUNvbm5lY3RTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICAvKipcbiAgICogT3B0aW9uYWw6IE5hbWUgb2YgdGhlIEtpbmVzaXMgU3RyZWFtIGZvciB0cmFuc2NyaXB0aW9uIGluZ2VzdGlvblxuICAgKiBEZWZhdWx0cyB0byAnc2NhLXRyYW5zY3JpcHRpb24tc3RyZWFtJ1xuICAgKi9cbiAgdHJhbnNjcmlwdGlvblN0cmVhbU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsOiBLTVMga2V5IGZvciBLaW5lc2lzIFN0cmVhbSBlbmNyeXB0aW9uXG4gICAqL1xuICBraW5lc2lzS21zS2V5Pzoga21zLklLZXk7XG59XG5cbmV4cG9ydCBjbGFzcyBTY2FDb25uZWN0U3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgY29ubmVjdEluc3RhbmNlOiBjb25uZWN0LkNmbkluc3RhbmNlO1xuICBwdWJsaWMgcmVhZG9ubHkgcGhvbmVOdW1iZXI6IGNvbm5lY3QuQ2ZuUGhvbmVOdW1iZXI7XG4gIHB1YmxpYyByZWFkb25seSBhZG1pbkNyZWRlbnRpYWxzOiBzZWNyZXRzbWFuYWdlci5JU2VjcmV0O1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBTY2FDb25uZWN0U3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3Qgc3RyZWFtTmFtZSA9IHByb3BzLnRyYW5zY3JpcHRpb25TdHJlYW1OYW1lID8/ICdzY2EtdHJhbnNjcmlwdGlvbi1zdHJlYW0nO1xuXG4gICAgLy8gSW1wb3J0IHRoZSBLaW5lc2lzIFN0cmVhbVxuICAgIGNvbnN0IHRyYW5zY3JpcHRpb25TdHJlYW0gPSBraW5lc2lzLlN0cmVhbS5mcm9tU3RyZWFtQXR0cmlidXRlcyhcbiAgICAgIHRoaXMsXG4gICAgICAnSW1wb3J0ZWRUcmFuc2NyaXB0aW9uU3RyZWFtJyxcbiAgICAgIHtcbiAgICAgICAgc3RyZWFtQXJuOiBgYXJuOmF3czpraW5lc2lzOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpzdHJlYW0vJHtzdHJlYW1OYW1lfWAsXG4gICAgICB9XG4gICAgKTtcblxuICAgIC8vIDEuIENyZWF0ZSBDb25uZWN0IEluc3RhbmNlIHdpdGggQ29udGFjdCBMZW5zIGVuYWJsZWRcbiAgICB0aGlzLmNvbm5lY3RJbnN0YW5jZSA9IG5ldyBjb25uZWN0LkNmbkluc3RhbmNlKHRoaXMsICdDb25uZWN0SW5zdGFuY2UnLCB7XG4gICAgICBpZGVudGl0eU1hbmFnZW1lbnRUeXBlOiAnQ09OTkVDVF9NQU5BR0VEJyxcbiAgICAgIGF0dHJpYnV0ZXM6IHtcbiAgICAgICAgaW5ib3VuZENhbGxzOiB0cnVlLFxuICAgICAgICBvdXRib3VuZENhbGxzOiB0cnVlLFxuICAgICAgICBjb250YWN0TGVuczogdHJ1ZSxcbiAgICAgICAgYXV0b1Jlc29sdmVCZXN0Vm9pY2VzOiB0cnVlLFxuICAgICAgICBjb250YWN0Zmxvd0xvZ3M6IHRydWUsXG4gICAgICB9LFxuICAgICAgaW5zdGFuY2VBbGlhczogYHNjYS1jb25uZWN0LSR7Y2RrLlN0YWNrLm9mKHRoaXMpLmFjY291bnR9YCxcbiAgICB9KTtcblxuICAgIC8vIEVuYWJsZSBhdHRyaWJ1dGVzIG5vdCB5ZXQgc3VwcG9ydGVkIGluIENmbkluc3RhbmNlLkF0dHJpYnV0ZXNQcm9wZXJ0eVxuICAgIGZvciAoY29uc3QgYXR0clR5cGUgb2YgWydCT1RfTUFOQUdFTUVOVCcsICdFTkFCTEVfQk9UX0FOQUxZVElDU19BTkRfVFJBTlNDUklQVFMnLCAnQVVUT01BVEVEX0lOVEVSQUNUSU9OX0xPRyddKSB7XG4gICAgICBjb25zdCByZXMgPSBuZXcgY3IuQXdzQ3VzdG9tUmVzb3VyY2UodGhpcywgYEVuYWJsZSR7YXR0clR5cGV9YCwge1xuICAgICAgICBvbkNyZWF0ZToge1xuICAgICAgICAgIHNlcnZpY2U6ICdDb25uZWN0JyxcbiAgICAgICAgICBhY3Rpb246ICd1cGRhdGVJbnN0YW5jZUF0dHJpYnV0ZScsXG4gICAgICAgICAgcGFyYW1ldGVyczoge1xuICAgICAgICAgICAgSW5zdGFuY2VJZDogdGhpcy5jb25uZWN0SW5zdGFuY2UuYXR0cklkLFxuICAgICAgICAgICAgQXR0cmlidXRlVHlwZTogYXR0clR5cGUsXG4gICAgICAgICAgICBWYWx1ZTogJ3RydWUnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiBjci5QaHlzaWNhbFJlc291cmNlSWQub2YoYCR7YXR0clR5cGV9LWVuYWJsZWRgKSxcbiAgICAgICAgfSxcbiAgICAgICAgcG9saWN5OiBjci5Bd3NDdXN0b21SZXNvdXJjZVBvbGljeS5mcm9tU3RhdGVtZW50cyhbXG4gICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgYWN0aW9uczogWydjb25uZWN0OlVwZGF0ZUluc3RhbmNlQXR0cmlidXRlJ10sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFt0aGlzLmNvbm5lY3RJbnN0YW5jZS5hdHRyQXJuXSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICBhY3Rpb25zOiBbJ2lhbTpQdXRSb2xlUG9saWN5J10sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgICAgIH0pLFxuICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgIGFjdGlvbnM6IFsnZHM6RGVzY3JpYmVEaXJlY3RvcmllcyddLFxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICAgIHJlcy5ub2RlLmFkZERlcGVuZGVuY3kodGhpcy5jb25uZWN0SW5zdGFuY2UpO1xuICAgIH1cblxuICAgIC8vIDIuIExvb2sgdXAgaG91cnMgb2Ygb3BlcmF0aW9uXG4gICAgY29uc3QgaG91cnNPZk9wZXJhdGlvbkxvb2t1cCA9IG5ldyBjci5Bd3NDdXN0b21SZXNvdXJjZSh0aGlzLCAnSG91cnNPZk9wZXJhdGlvbkxvb2t1cCcsIHtcbiAgICAgIG9uQ3JlYXRlOiB7XG4gICAgICAgIHNlcnZpY2U6ICdDb25uZWN0JyxcbiAgICAgICAgYWN0aW9uOiAnbGlzdEhvdXJzT2ZPcGVyYXRpb25zJyxcbiAgICAgICAgcGFyYW1ldGVyczoge1xuICAgICAgICAgIEluc3RhbmNlSWQ6IHRoaXMuY29ubmVjdEluc3RhbmNlLmF0dHJJZCxcbiAgICAgICAgfSxcbiAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiBjci5QaHlzaWNhbFJlc291cmNlSWQub2YoJ0hvdXJzT2ZPcGVyYXRpb25Mb29rdXAnKSxcbiAgICAgIH0sXG4gICAgICBwb2xpY3k6IGNyLkF3c0N1c3RvbVJlc291cmNlUG9saWN5LmZyb21TZGtDYWxscyh7XG4gICAgICAgIHJlc291cmNlczogW3RoaXMuY29ubmVjdEluc3RhbmNlLmF0dHJBcm5dLFxuICAgICAgfSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBob3Vyc09mT3BlcmF0aW9uQXJuID0gaG91cnNPZk9wZXJhdGlvbkxvb2t1cC5nZXRSZXNwb25zZUZpZWxkKCdIb3Vyc09mT3BlcmF0aW9uU3VtbWFyeUxpc3QuMC5Bcm4nKTtcblxuICAgIC8vIDMuIENyZWF0ZSBxdWV1ZSBmb3Igcm91dGluZyBjYWxscyB0byBhZ2VudHNcbiAgICBjb25zdCBxdWV1ZSA9IG5ldyBjb25uZWN0LkNmblF1ZXVlKHRoaXMsICdBZ2VudFF1ZXVlJywge1xuICAgICAgaW5zdGFuY2VBcm46IHRoaXMuY29ubmVjdEluc3RhbmNlLmF0dHJBcm4sXG4gICAgICBuYW1lOiAnU0NBLUFnZW50LVF1ZXVlJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUXVldWUgZm9yIHJvdXRpbmcgY2FsbHMgdG8gYWdlbnRzJyxcbiAgICAgIGhvdXJzT2ZPcGVyYXRpb25Bcm46IGhvdXJzT2ZPcGVyYXRpb25Bcm4sXG4gICAgfSk7XG5cbiAgICAvLyA0LiBDcmVhdGUgcm91dGluZyBwcm9maWxlXG4gICAgY29uc3QgYWdlbnRSb3V0aW5nUHJvZmlsZSA9IG5ldyBjb25uZWN0LkNmblJvdXRpbmdQcm9maWxlKHRoaXMsICdBZ2VudFJvdXRpbmdQcm9maWxlJywge1xuICAgICAgaW5zdGFuY2VBcm46IHRoaXMuY29ubmVjdEluc3RhbmNlLmF0dHJBcm4sXG4gICAgICBuYW1lOiAnU0NBLUFnZW50LVJvdXRpbmctUHJvZmlsZScsXG4gICAgICBkZXNjcmlwdGlvbjogJ1JvdXRpbmcgcHJvZmlsZSBmb3IgYWdlbnRzIHRvIHJlY2VpdmUgY2FsbHMgZnJvbSBTQ0EtQWdlbnQtUXVldWUnLFxuICAgICAgZGVmYXVsdE91dGJvdW5kUXVldWVBcm46IHF1ZXVlLmF0dHJRdWV1ZUFybixcbiAgICAgIG1lZGlhQ29uY3VycmVuY2llczogW1xuICAgICAgICB7XG4gICAgICAgICAgY2hhbm5lbDogJ1ZPSUNFJyxcbiAgICAgICAgICBjb25jdXJyZW5jeTogMSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICBxdWV1ZUNvbmZpZ3M6IFtcbiAgICAgICAge1xuICAgICAgICAgIHF1ZXVlUmVmZXJlbmNlOiB7XG4gICAgICAgICAgICBjaGFubmVsOiAnVk9JQ0UnLFxuICAgICAgICAgICAgcXVldWVBcm46IHF1ZXVlLmF0dHJRdWV1ZUFybixcbiAgICAgICAgICB9LFxuICAgICAgICAgIHByaW9yaXR5OiAxLFxuICAgICAgICAgIGRlbGF5OiAwLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIGFnZW50Um91dGluZ1Byb2ZpbGUuYWRkRGVwZW5kZW5jeShxdWV1ZSk7XG5cbiAgICAvLyA1LiBQcm92aXNpb24gUGhvbmUgTnVtYmVyXG4gICAgdGhpcy5waG9uZU51bWJlciA9IG5ldyBjb25uZWN0LkNmblBob25lTnVtYmVyKHRoaXMsICdJbmJvdW5kUGhvbmVOdW1iZXInLCB7XG4gICAgICB0YXJnZXRBcm46IHRoaXMuY29ubmVjdEluc3RhbmNlLmF0dHJBcm4sXG4gICAgICBjb3VudHJ5Q29kZTogJ1VTJyxcbiAgICAgIHR5cGU6ICdUT0xMX0ZSRUUnLFxuICAgICAgZGVzY3JpcHRpb246ICdQaG9uZSBudW1iZXIgZm9yIFNDQSB0ZXN0aW5nJyxcbiAgICB9KTtcblxuICAgIHRoaXMucGhvbmVOdW1iZXIuYWRkRGVwZW5kZW5jeSh0aGlzLmNvbm5lY3RJbnN0YW5jZSk7XG5cbiAgICAvLyA2LiBHZW5lcmF0ZSBhZG1pbiBwYXNzd29yZFxuICAgIGNvbnN0IGFkbWluUGFzc3dvcmQgPSBuZXcgc2VjcmV0c21hbmFnZXIuU2VjcmV0KHRoaXMsICdBZG1pblBhc3N3b3JkJywge1xuICAgICAgZ2VuZXJhdGVTZWNyZXRTdHJpbmc6IHtcbiAgICAgICAgZXhjbHVkZVB1bmN0dWF0aW9uOiB0cnVlLFxuICAgICAgICBleGNsdWRlVXBwZXJjYXNlOiBmYWxzZSxcbiAgICAgICAgaW5jbHVkZVNwYWNlOiBmYWxzZSxcbiAgICAgICAgcGFzc3dvcmRMZW5ndGg6IDE2LFxuICAgICAgICByZXF1aXJlRWFjaEluY2x1ZGVkVHlwZTogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FtYXpvbiBDb25uZWN0IGFkbWluIHVzZXIgcGFzc3dvcmQnLFxuICAgIH0pO1xuXG4gICAgLy8gNy4gTG9vayB1cCBzZWN1cml0eSBwcm9maWxlc1xuICAgIGNvbnN0IGxvb2t1cFByb2ZpbGVzRnVuY3Rpb24gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdMb29rdXBQcm9maWxlc0Z1bmN0aW9uJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTIsXG4gICAgICBoYW5kbGVyOiAnaW5kZXguaGFuZGxlcicsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygyKSxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21JbmxpbmUoYFxuaW1wb3J0IGpzb25cbmltcG9ydCBib3RvM1xuXG5jb25uZWN0ID0gYm90bzMuY2xpZW50KCdjb25uZWN0JylcblxuZGVmIGhhbmRsZXIoZXZlbnQsIGNvbnRleHQpOlxuICAgIHByaW50KGZcIkV2ZW50OiB7anNvbi5kdW1wcyhldmVudCl9XCIpXG4gICAgXG4gICAgcmVxdWVzdF90eXBlID0gZXZlbnRbJ1JlcXVlc3RUeXBlJ11cbiAgICBpbnN0YW5jZV9pZCA9IGV2ZW50WydSZXNvdXJjZVByb3BlcnRpZXMnXVsnSW5zdGFuY2VJZCddXG4gICAgXG4gICAgaWYgcmVxdWVzdF90eXBlID09ICdEZWxldGUnOlxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgJ1BoeXNpY2FsUmVzb3VyY2VJZCc6IGYncHJvZmlsZXMtbG9va3VwLXtpbnN0YW5jZV9pZH0nLFxuICAgICAgICAgICAgJ0RhdGEnOiB7fVxuICAgICAgICB9XG4gICAgXG4gICAgdHJ5OlxuICAgICAgICBzZWN1cml0eV9wcm9maWxlcyA9IGNvbm5lY3QubGlzdF9zZWN1cml0eV9wcm9maWxlcyhJbnN0YW5jZUlkPWluc3RhbmNlX2lkLCBNYXhSZXN1bHRzPTUwKVxuICAgICAgICBhZG1pbl9wcm9maWxlX2FybiA9IG5leHQoXG4gICAgICAgICAgICBwWydBcm4nXSBmb3IgcCBpbiBzZWN1cml0eV9wcm9maWxlc1snU2VjdXJpdHlQcm9maWxlU3VtbWFyeUxpc3QnXSBcbiAgICAgICAgICAgIGlmIHBbJ05hbWUnXSA9PSAnQWRtaW4nXG4gICAgICAgIClcbiAgICAgICAgYWdlbnRfcHJvZmlsZV9hcm4gPSBuZXh0KFxuICAgICAgICAgICAgcFsnQXJuJ10gZm9yIHAgaW4gc2VjdXJpdHlfcHJvZmlsZXNbJ1NlY3VyaXR5UHJvZmlsZVN1bW1hcnlMaXN0J10gXG4gICAgICAgICAgICBpZiBwWydOYW1lJ10gPT0gJ0FnZW50J1xuICAgICAgICApXG4gICAgICAgIFxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgJ1BoeXNpY2FsUmVzb3VyY2VJZCc6IGYncHJvZmlsZXMtbG9va3VwLXtpbnN0YW5jZV9pZH0nLFxuICAgICAgICAgICAgJ0RhdGEnOiB7XG4gICAgICAgICAgICAgICAgJ0FkbWluU2VjdXJpdHlQcm9maWxlQXJuJzogYWRtaW5fcHJvZmlsZV9hcm4sXG4gICAgICAgICAgICAgICAgJ0FnZW50U2VjdXJpdHlQcm9maWxlQXJuJzogYWdlbnRfcHJvZmlsZV9hcm5cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOlxuICAgICAgICBwcmludChmXCJFcnJvcjoge3N0cihlKX1cIilcbiAgICAgICAgcmFpc2VcbmApLFxuICAgIH0pO1xuXG4gICAgbG9va3VwUHJvZmlsZXNGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWydjb25uZWN0Okxpc3RTZWN1cml0eVByb2ZpbGVzJ10sXG4gICAgICByZXNvdXJjZXM6IFt0aGlzLmNvbm5lY3RJbnN0YW5jZS5hdHRyQXJuXSxcbiAgICB9KSk7XG5cbiAgICBjb25zdCBsb29rdXBQcm9maWxlc1Byb3ZpZGVyID0gbmV3IGNyLlByb3ZpZGVyKHRoaXMsICdMb29rdXBQcm9maWxlc1Byb3ZpZGVyJywge1xuICAgICAgb25FdmVudEhhbmRsZXI6IGxvb2t1cFByb2ZpbGVzRnVuY3Rpb24sXG4gICAgfSk7XG5cbiAgICBjb25zdCBwcm9maWxlc0xvb2t1cCA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ1Byb2ZpbGVzTG9va3VwJywge1xuICAgICAgc2VydmljZVRva2VuOiBsb29rdXBQcm9maWxlc1Byb3ZpZGVyLnNlcnZpY2VUb2tlbixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgSW5zdGFuY2VJZDogdGhpcy5jb25uZWN0SW5zdGFuY2UuYXR0cklkLFxuICAgICAgICBWZXJzaW9uOiAnMicsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgcHJvZmlsZXNMb29rdXAubm9kZS5hZGREZXBlbmRlbmN5KHRoaXMuY29ubmVjdEluc3RhbmNlKTtcblxuICAgIC8vIDguIENyZWF0ZSBhZG1pbiB1c2VyXG4gICAgY29uc3QgYWRtaW5Vc2VyID0gbmV3IGNvbm5lY3QuQ2ZuVXNlcih0aGlzLCAnQ29ubmVjdEFkbWluVXNlcicsIHtcbiAgICAgIGluc3RhbmNlQXJuOiB0aGlzLmNvbm5lY3RJbnN0YW5jZS5hdHRyQXJuLFxuICAgICAgdXNlcm5hbWU6ICdhZG1pbicsXG4gICAgICBwYXNzd29yZDogYWRtaW5QYXNzd29yZC5zZWNyZXRWYWx1ZS51bnNhZmVVbndyYXAoKSxcbiAgICAgIGlkZW50aXR5SW5mbzoge1xuICAgICAgICBmaXJzdE5hbWU6ICdTQ0EnLFxuICAgICAgICBsYXN0TmFtZTogJ0FkbWluJyxcbiAgICAgICAgZW1haWw6ICdhZG1pbkBleGFtcGxlLmNvbScsXG4gICAgICB9LFxuICAgICAgcGhvbmVDb25maWc6IHtcbiAgICAgICAgcGhvbmVUeXBlOiAnU09GVF9QSE9ORScsXG4gICAgICAgIGF1dG9BY2NlcHQ6IGZhbHNlLFxuICAgICAgICBhZnRlckNvbnRhY3RXb3JrVGltZUxpbWl0OiAwLFxuICAgICAgfSxcbiAgICAgIHJvdXRpbmdQcm9maWxlQXJuOiBhZ2VudFJvdXRpbmdQcm9maWxlLmF0dHJSb3V0aW5nUHJvZmlsZUFybixcbiAgICAgIHNlY3VyaXR5UHJvZmlsZUFybnM6IFtcbiAgICAgICAgcHJvZmlsZXNMb29rdXAuZ2V0QXR0U3RyaW5nKCdBZG1pblNlY3VyaXR5UHJvZmlsZUFybicpLFxuICAgICAgICBwcm9maWxlc0xvb2t1cC5nZXRBdHRTdHJpbmcoJ0FnZW50U2VjdXJpdHlQcm9maWxlQXJuJyksXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgYWRtaW5Vc2VyLmFkZERlcGVuZGVuY3kodGhpcy5jb25uZWN0SW5zdGFuY2UpO1xuICAgIGFkbWluVXNlci5ub2RlLmFkZERlcGVuZGVuY3kocHJvZmlsZXNMb29rdXApO1xuICAgIGFkbWluVXNlci5ub2RlLmFkZERlcGVuZGVuY3koYWdlbnRSb3V0aW5nUHJvZmlsZSk7XG5cbiAgICB0aGlzLmFkbWluQ3JlZGVudGlhbHMgPSBhZG1pblBhc3N3b3JkO1xuXG4gICAgLy8gOS4gQ29uZmlndXJlIENvbnRhY3QgTGVucyBzdHJlYW1pbmdcbiAgICBjb25zdCBjb25maWd1cmVDb250YWN0TGVuc0Z1bmN0aW9uID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnQ29uZmlndXJlQ29udGFjdExlbnNGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzEyLFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMiksXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcbmltcG9ydCBqc29uXG5pbXBvcnQgYm90bzNcblxuY29ubmVjdCA9IGJvdG8zLmNsaWVudCgnY29ubmVjdCcpXG5cbmRlZiBoYW5kbGVyKGV2ZW50LCBjb250ZXh0KTpcbiAgICBwcmludChmXCJFdmVudDoge2pzb24uZHVtcHMoZXZlbnQpfVwiKVxuICAgIFxuICAgIHJlcXVlc3RfdHlwZSA9IGV2ZW50WydSZXF1ZXN0VHlwZSddXG4gICAgaW5zdGFuY2VfaWQgPSBldmVudFsnUmVzb3VyY2VQcm9wZXJ0aWVzJ11bJ0luc3RhbmNlSWQnXVxuICAgIHN0cmVhbV9hcm4gPSBldmVudFsnUmVzb3VyY2VQcm9wZXJ0aWVzJ11bJ1N0cmVhbUFybiddXG4gICAgXG4gICAgcGh5c2ljYWxfaWQgPSBmJ2NvbnRhY3QtbGVucy1jb25maWcte2luc3RhbmNlX2lkfSdcbiAgICBcbiAgICB0cnk6XG4gICAgICAgIGlmIHJlcXVlc3RfdHlwZSA9PSAnQ3JlYXRlJyBvciByZXF1ZXN0X3R5cGUgPT0gJ1VwZGF0ZSc6XG4gICAgICAgICAgICB0cnk6XG4gICAgICAgICAgICAgICAgY29uZmlncyA9IGNvbm5lY3QubGlzdF9pbnN0YW5jZV9zdG9yYWdlX2NvbmZpZ3MoXG4gICAgICAgICAgICAgICAgICAgIEluc3RhbmNlSWQ9aW5zdGFuY2VfaWQsXG4gICAgICAgICAgICAgICAgICAgIFJlc291cmNlVHlwZT0nUkVBTF9USU1FX0NPTlRBQ1RfQU5BTFlTSVNfVk9JQ0VfU0VHTUVOVFMnXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIGNvbmZpZ3MuZ2V0KCdTdG9yYWdlQ29uZmlncycpOlxuICAgICAgICAgICAgICAgICAgICBwcmludChmXCJDb250YWN0IExlbnMgYWxyZWFkeSBjb25maWd1cmVkXCIpXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAnUGh5c2ljYWxSZXNvdXJjZUlkJzogcGh5c2ljYWxfaWQsXG4gICAgICAgICAgICAgICAgICAgICAgICAnRGF0YSc6IHsnU3RhdHVzJzogJ0FscmVhZHlDb25maWd1cmVkJ31cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOlxuICAgICAgICAgICAgICAgIHByaW50KGZcIk5vIGV4aXN0aW5nIGNvbmZpZzoge2V9XCIpXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJlc3BvbnNlID0gY29ubmVjdC5hc3NvY2lhdGVfaW5zdGFuY2Vfc3RvcmFnZV9jb25maWcoXG4gICAgICAgICAgICAgICAgSW5zdGFuY2VJZD1pbnN0YW5jZV9pZCxcbiAgICAgICAgICAgICAgICBSZXNvdXJjZVR5cGU9J1JFQUxfVElNRV9DT05UQUNUX0FOQUxZU0lTX1ZPSUNFX1NFR01FTlRTJyxcbiAgICAgICAgICAgICAgICBTdG9yYWdlQ29uZmlnPXtcbiAgICAgICAgICAgICAgICAgICAgJ1N0b3JhZ2VUeXBlJzogJ0tJTkVTSVNfU1RSRUFNJyxcbiAgICAgICAgICAgICAgICAgICAgJ0tpbmVzaXNTdHJlYW1Db25maWcnOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAnU3RyZWFtQXJuJzogc3RyZWFtX2FyblxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBwcmludChmXCJDb250YWN0IExlbnMgY29uZmlndXJlZDoge3Jlc3BvbnNlfVwiKVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICdQaHlzaWNhbFJlc291cmNlSWQnOiBwaHlzaWNhbF9pZCxcbiAgICAgICAgICAgICAgICAnRGF0YSc6IHtcbiAgICAgICAgICAgICAgICAgICAgJ1N0YXR1cyc6ICdDb25maWd1cmVkJyxcbiAgICAgICAgICAgICAgICAgICAgJ0Fzc29jaWF0aW9uSWQnOiByZXNwb25zZS5nZXQoJ0Fzc29jaWF0aW9uSWQnLCAnJylcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgZWxpZiByZXF1ZXN0X3R5cGUgPT0gJ0RlbGV0ZSc6XG4gICAgICAgICAgICB0cnk6XG4gICAgICAgICAgICAgICAgY29uZmlncyA9IGNvbm5lY3QubGlzdF9pbnN0YW5jZV9zdG9yYWdlX2NvbmZpZ3MoXG4gICAgICAgICAgICAgICAgICAgIEluc3RhbmNlSWQ9aW5zdGFuY2VfaWQsXG4gICAgICAgICAgICAgICAgICAgIFJlc291cmNlVHlwZT0nUkVBTF9USU1FX0NPTlRBQ1RfQU5BTFlTSVNfVk9JQ0VfU0VHTUVOVFMnXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGZvciBjb25maWcgaW4gY29uZmlncy5nZXQoJ1N0b3JhZ2VDb25maWdzJywgW10pOlxuICAgICAgICAgICAgICAgICAgICBjb25uZWN0LmRpc2Fzc29jaWF0ZV9pbnN0YW5jZV9zdG9yYWdlX2NvbmZpZyhcbiAgICAgICAgICAgICAgICAgICAgICAgIEluc3RhbmNlSWQ9aW5zdGFuY2VfaWQsXG4gICAgICAgICAgICAgICAgICAgICAgICBBc3NvY2lhdGlvbklkPWNvbmZpZ1snQXNzb2NpYXRpb25JZCddLFxuICAgICAgICAgICAgICAgICAgICAgICAgUmVzb3VyY2VUeXBlPSdSRUFMX1RJTUVfQ09OVEFDVF9BTkFMWVNJU19WT0lDRV9TRUdNRU5UUydcbiAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOlxuICAgICAgICAgICAgICAgIHByaW50KGZcIkVycm9yIGR1cmluZyBjbGVhbnVwOiB7ZX1cIilcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAnUGh5c2ljYWxSZXNvdXJjZUlkJzogcGh5c2ljYWxfaWQsXG4gICAgICAgICAgICAgICAgJ0RhdGEnOiB7J1N0YXR1cyc6ICdEZWxldGVkJ31cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZTpcbiAgICAgICAgcHJpbnQoZlwiRXJyb3I6IHtzdHIoZSl9XCIpXG4gICAgICAgIHJhaXNlXG5gKSxcbiAgICB9KTtcblxuICAgIGNvbmZpZ3VyZUNvbnRhY3RMZW5zRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2Nvbm5lY3Q6QXNzb2NpYXRlSW5zdGFuY2VTdG9yYWdlQ29uZmlnJyxcbiAgICAgICAgJ2Nvbm5lY3Q6RGlzYXNzb2NpYXRlSW5zdGFuY2VTdG9yYWdlQ29uZmlnJyxcbiAgICAgICAgJ2Nvbm5lY3Q6TGlzdEluc3RhbmNlU3RvcmFnZUNvbmZpZ3MnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW3RoaXMuY29ubmVjdEluc3RhbmNlLmF0dHJBcm5dLFxuICAgIH0pKTtcblxuICAgIGNvbmZpZ3VyZUNvbnRhY3RMZW5zRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsna2luZXNpczpEZXNjcmliZVN0cmVhbSddLFxuICAgICAgcmVzb3VyY2VzOiBbdHJhbnNjcmlwdGlvblN0cmVhbS5zdHJlYW1Bcm5dLFxuICAgIH0pKTtcblxuICAgIGNvbmZpZ3VyZUNvbnRhY3RMZW5zRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnaWFtOlB1dFJvbGVQb2xpY3knXSxcbiAgICAgIHJlc291cmNlczogWydhcm46YXdzOmlhbTo6Kjpyb2xlL2F3cy1zZXJ2aWNlLXJvbGUvY29ubmVjdC5hbWF6b25hd3MuY29tL0FXU1NlcnZpY2VSb2xlRm9yQW1hem9uQ29ubmVjdConXSxcbiAgICB9KSk7XG5cbiAgICBjb25zdCBjb25maWd1cmVDb250YWN0TGVuc1Byb3ZpZGVyID0gbmV3IGNyLlByb3ZpZGVyKHRoaXMsICdDb25maWd1cmVDb250YWN0TGVuc1Byb3ZpZGVyJywge1xuICAgICAgb25FdmVudEhhbmRsZXI6IGNvbmZpZ3VyZUNvbnRhY3RMZW5zRnVuY3Rpb24sXG4gICAgfSk7XG5cbiAgICBjb25zdCBjb250YWN0TGVuc0NvbmZpZyA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ0NvbnRhY3RMZW5zQ29uZmlnJywge1xuICAgICAgc2VydmljZVRva2VuOiBjb25maWd1cmVDb250YWN0TGVuc1Byb3ZpZGVyLnNlcnZpY2VUb2tlbixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgSW5zdGFuY2VJZDogdGhpcy5jb25uZWN0SW5zdGFuY2UuYXR0cklkLFxuICAgICAgICBTdHJlYW1Bcm46IHRyYW5zY3JpcHRpb25TdHJlYW0uc3RyZWFtQXJuLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnRhY3RMZW5zQ29uZmlnLm5vZGUuYWRkRGVwZW5kZW5jeSh0aGlzLmNvbm5lY3RJbnN0YW5jZSk7XG5cblxuICAgIC8vIDEwLiBDb25maWd1cmUgQ2FsbCBSZWNvcmRpbmcgc3RvcmFnZSAocmVxdWlyZWQgZm9yIENvbnRhY3QgTGVucyB0cmFuc2NyaXB0aW9ucylcbiAgICBjb25zdCBjYWxsUmVjb3JkaW5nQnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCAnQ2FsbFJlY29yZGluZ0J1Y2tldCcsIHtcbiAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGF1dG9EZWxldGVPYmplY3RzOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgY29uc3QgY2FsbFJlY29yZGluZ0NvbmZpZyA9IG5ldyBjci5Bd3NDdXN0b21SZXNvdXJjZSh0aGlzLCAnQ2FsbFJlY29yZGluZ0NvbmZpZycsIHtcbiAgICAgIG9uQ3JlYXRlOiB7XG4gICAgICAgIHNlcnZpY2U6ICdDb25uZWN0JyxcbiAgICAgICAgYWN0aW9uOiAnYXNzb2NpYXRlSW5zdGFuY2VTdG9yYWdlQ29uZmlnJyxcbiAgICAgICAgcGFyYW1ldGVyczoge1xuICAgICAgICAgIEluc3RhbmNlSWQ6IHRoaXMuY29ubmVjdEluc3RhbmNlLmF0dHJJZCxcbiAgICAgICAgICBSZXNvdXJjZVR5cGU6ICdDQUxMX1JFQ09SRElOR1MnLFxuICAgICAgICAgIFN0b3JhZ2VDb25maWc6IHtcbiAgICAgICAgICAgIFN0b3JhZ2VUeXBlOiAnUzMnLFxuICAgICAgICAgICAgUzNDb25maWc6IHtcbiAgICAgICAgICAgICAgQnVja2V0TmFtZTogY2FsbFJlY29yZGluZ0J1Y2tldC5idWNrZXROYW1lLFxuICAgICAgICAgICAgICBCdWNrZXRQcmVmaXg6ICdjYWxsLXJlY29yZGluZ3MnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBwaHlzaWNhbFJlc291cmNlSWQ6IGNyLlBoeXNpY2FsUmVzb3VyY2VJZC5mcm9tUmVzcG9uc2UoJ0Fzc29jaWF0aW9uSWQnKSxcbiAgICAgIH0sXG4gICAgICBvbkRlbGV0ZToge1xuICAgICAgICBzZXJ2aWNlOiAnQ29ubmVjdCcsXG4gICAgICAgIGFjdGlvbjogJ2Rpc2Fzc29jaWF0ZUluc3RhbmNlU3RvcmFnZUNvbmZpZycsXG4gICAgICAgIHBhcmFtZXRlcnM6IHtcbiAgICAgICAgICBJbnN0YW5jZUlkOiB0aGlzLmNvbm5lY3RJbnN0YW5jZS5hdHRySWQsXG4gICAgICAgICAgQXNzb2NpYXRpb25JZDogbmV3IGNyLlBoeXNpY2FsUmVzb3VyY2VJZFJlZmVyZW5jZSgpLFxuICAgICAgICAgIFJlc291cmNlVHlwZTogJ0NBTExfUkVDT1JESU5HUycsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgcG9saWN5OiBjci5Bd3NDdXN0b21SZXNvdXJjZVBvbGljeS5mcm9tU3RhdGVtZW50cyhbXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBhY3Rpb25zOiBbJ2Nvbm5lY3Q6QXNzb2NpYXRlSW5zdGFuY2VTdG9yYWdlQ29uZmlnJywgJ2Nvbm5lY3Q6RGlzYXNzb2NpYXRlSW5zdGFuY2VTdG9yYWdlQ29uZmlnJ10sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbdGhpcy5jb25uZWN0SW5zdGFuY2UuYXR0ckFybl0sXG4gICAgICAgIH0pLFxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgYWN0aW9uczogWydzMzpHZXRCdWNrZXRMb2NhdGlvbicsICdzMzpHZXRCdWNrZXRBY2wnXSxcbiAgICAgICAgICByZXNvdXJjZXM6IFtjYWxsUmVjb3JkaW5nQnVja2V0LmJ1Y2tldEFybl0sXG4gICAgICAgIH0pLFxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgYWN0aW9uczogWydpYW06UHV0Um9sZVBvbGljeSddLFxuICAgICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICAgIH0pLFxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgYWN0aW9uczogWydkczpEZXNjcmliZURpcmVjdG9yaWVzJ10sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgICAgfSksXG4gICAgICBdKSxcbiAgICB9KTtcbiAgICBjYWxsUmVjb3JkaW5nQ29uZmlnLm5vZGUuYWRkRGVwZW5kZW5jeSh0aGlzLmNvbm5lY3RJbnN0YW5jZSk7XG4gICAgY2FsbFJlY29yZGluZ0NvbmZpZy5ub2RlLmFkZERlcGVuZGVuY3koY2FsbFJlY29yZGluZ0J1Y2tldCk7XG4gICAgLy8gT3V0cHV0c1xuXG4gICAgLy8gMTEuIFMzIFBvc3QtQ2FsbCBBbmFseXRpY3MgUHJvY2Vzc29yIOKAlCBwYXJzZXMgQ29udGFjdCBMZW5zIGFuYWx5c2lzIGZpbGVzIGFuZCB3cml0ZXMgdG8gRHluYW1vREJcbiAgICBjb25zdCBzM0FuYWx5dGljc1Byb2Nlc3NvciA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ1MzQW5hbHl0aWNzUHJvY2Vzc29yJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTMsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlci5sYW1iZGFfaGFuZGxlcicsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoJ2JhY2tlbmQvczMtYW5hbHl0aWNzLXByb2Nlc3NvcicsIHtcbiAgICAgICAgYnVuZGxpbmc6IHtcbiAgICAgICAgICBpbWFnZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTMuYnVuZGxpbmdJbWFnZSxcbiAgICAgICAgICBjb21tYW5kOiBbJ2Jhc2gnLCAnLWMnLCAncGlwIGluc3RhbGwgLXIgcmVxdWlyZW1lbnRzLnR4dCAtdCAvYXNzZXQtb3V0cHV0ICYmIGNwIC1yIC4gL2Fzc2V0LW91dHB1dCddLFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcyg1KSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFRSQU5TQ1JJUFRJT05TX1RBQkxFOiBzdHJlYW1OYW1lLnJlcGxhY2UoJ3RyYW5zY3JpcHRpb24tc3RyZWFtJywgJ3RyYW5zY3JpcHRpb25zJyksXG4gICAgICAgIFBPV0VSVE9PTFNfU0VSVklDRV9OQU1FOiAnczMtYW5hbHl0aWNzLXByb2Nlc3NvcicsXG4gICAgICAgIFBPV0VSVE9PTFNfTUVUUklDU19OQU1FU1BBQ0U6ICdTQ0EnLFxuICAgICAgICBMT0dfTEVWRUw6ICdJTkZPJyxcbiAgICAgIH0sXG4gICAgICB0cmFjaW5nOiBsYW1iZGEuVHJhY2luZy5BQ1RJVkUsXG4gICAgfSk7XG5cbiAgICAvLyBHcmFudCBEeW5hbW9EQiB3cml0ZSBhY2Nlc3NcbiAgICBzM0FuYWx5dGljc1Byb2Nlc3Nvci5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWydkeW5hbW9kYjpQdXRJdGVtJywgJ2R5bmFtb2RiOkJhdGNoV3JpdGVJdGVtJ10sXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpkeW5hbW9kYjoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06dGFibGUvc2NhLXRyYW5zY3JpcHRpb25zYF0sXG4gICAgfSkpO1xuXG4gICAgLy8gR3JhbnQgUzMgcmVhZCBhY2Nlc3NcbiAgICBjYWxsUmVjb3JkaW5nQnVja2V0LmdyYW50UmVhZChzM0FuYWx5dGljc1Byb2Nlc3Nvcik7XG5cbiAgICAvLyBUcmlnZ2VyIG9uIEFuYWx5c2lzIEpTT04gZmlsZXNcbiAgICBjb25zdCBzM0V2ZW50U291cmNlID0gbmV3IChyZXF1aXJlKCdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhLWV2ZW50LXNvdXJjZXMnKSBhcyB0eXBlb2YgaW1wb3J0KCdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhLWV2ZW50LXNvdXJjZXMnKSkuUzNFdmVudFNvdXJjZShjYWxsUmVjb3JkaW5nQnVja2V0LCB7XG4gICAgICBldmVudHM6IFtjZGsuYXdzX3MzLkV2ZW50VHlwZS5PQkpFQ1RfQ1JFQVRFRF0sXG4gICAgICBmaWx0ZXJzOiBbeyBwcmVmaXg6ICdBbmFseXNpcy8nLCBzdWZmaXg6ICcuanNvbicgfV0sXG4gICAgfSk7XG4gICAgczNBbmFseXRpY3NQcm9jZXNzb3IuYWRkRXZlbnRTb3VyY2UoczNFdmVudFNvdXJjZSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ29ubmVjdEluc3RhbmNlSWQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5jb25uZWN0SW5zdGFuY2UuYXR0cklkLFxuICAgICAgZGVzY3JpcHRpb246ICdBbWF6b24gQ29ubmVjdCBJbnN0YW5jZSBJRCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ29ubmVjdEluc3RhbmNlQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMuY29ubmVjdEluc3RhbmNlLmF0dHJBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FtYXpvbiBDb25uZWN0IEluc3RhbmNlIEFSTicsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUXVldWVJZCcsIHtcbiAgICAgIHZhbHVlOiBxdWV1ZS5hdHRyUXVldWVBcm4uc3BsaXQoJy8nKS5wb3AoKSEsXG4gICAgICBkZXNjcmlwdGlvbjogJ1F1ZXVlIElEJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdQaG9uZU51bWJlcicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnBob25lTnVtYmVyLmF0dHJBZGRyZXNzLFxuICAgICAgZGVzY3JpcHRpb246ICdQaG9uZSBOdW1iZXIgKEUuMTY0IGZvcm1hdCknLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1Bob25lTnVtYmVyQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMucGhvbmVOdW1iZXIuYXR0clBob25lTnVtYmVyQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdQaG9uZSBOdW1iZXIgQVJOJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDb25uZWN0TG9naW5VcmwnLCB7XG4gICAgICB2YWx1ZTogYGh0dHBzOi8vJHt0aGlzLmNvbm5lY3RJbnN0YW5jZS5pbnN0YW5jZUFsaWFzfS5teS5jb25uZWN0LmF3cy9jb25uZWN0L2xvZ2luYCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQW1hem9uIENvbm5lY3QgbG9naW4gVVJMJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdHZXRDcmVkZW50aWFsc0NvbW1hbmQnLCB7XG4gICAgICB2YWx1ZTogYGF3cyBzZWNyZXRzbWFuYWdlciBnZXQtc2VjcmV0LXZhbHVlIC0tc2VjcmV0LWlkICR7YWRtaW5QYXNzd29yZC5zZWNyZXRBcm59IC0tcXVlcnkgU2VjcmV0U3RyaW5nIC0tb3V0cHV0IHRleHRgLFxuICAgICAgZGVzY3JpcHRpb246ICdDb21tYW5kIHRvIHJldHJpZXZlIGFkbWluIGNyZWRlbnRpYWxzJyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDREsgTmFnIFN1cHByZXNzaW9uc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRTdGFja1N1cHByZXNzaW9ucyh0aGlzLCBbXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTQnLFxuICAgICAgICByZWFzb246ICdBV1MgbWFuYWdlZCBwb2xpY3kgQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlIGlzIGFwcHJvcHJpYXRlIGZvciBMYW1iZGEgZnVuY3Rpb25zLiAnICtcbiAgICAgICAgICAgICAgICAnVGhpcyBpbmNsdWRlcyBDREsgY3VzdG9tIHJlc291cmNlIExhbWJkYXMgdGhhdCBhcmUgbWFuYWdlZCBieSB0aGUgQ0RLIGZyYW1ld29yay4nLFxuICAgICAgICBhcHBsaWVzVG86IFsnUG9saWN5Ojphcm46PEFXUzo6UGFydGl0aW9uPjppYW06OmF3czpwb2xpY3kvc2VydmljZS1yb2xlL0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZScsXG4gICAgICAgICAgJ1BvbGljeTo6YXJuOjxBV1M6OlBhcnRpdGlvbj46aWFtOjphd3M6cG9saWN5L3NlcnZpY2Utcm9sZS9BV1NMYW1iZGFCYXNpY0R1cmFibGVFeGVjdXRpb25Sb2xlUG9saWN5J10sXG4gICAgICB9LFxuICAgIF0pO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFN0YWNrU3VwcHJlc3Npb25zKHRoaXMsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtTDEnLFxuICAgICAgICByZWFzb246ICdDREsgY3VzdG9tIHJlc291cmNlIExhbWJkYXMgdXNlIHJ1bnRpbWVzIG1hbmFnZWQgYnkgdGhlIENESyBmcmFtZXdvcmsuICcgK1xuICAgICAgICAgICAgICAgICdUaGVzZSBhcmUgaW50ZXJuYWwgaW1wbGVtZW50YXRpb24gZGV0YWlscyBhbmQgd2lsbCBiZSB1cGRhdGVkIHdoZW4gQ0RLIHVwZGF0ZXMuJyxcbiAgICAgIH0sXG4gICAgXSk7XG5cblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRTdGFja1N1cHByZXNzaW9ucyh0aGlzLCBbXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLVMxJyxcbiAgICAgICAgcmVhc29uOiAnQ2FsbCByZWNvcmRpbmcgYnVja2V0IGRvZXMgbm90IHJlcXVpcmUgYWNjZXNzIGxvZ2dpbmcgZm9yIHRoaXMgc29sdXRpb24uJyxcbiAgICAgIH0sXG4gICAgXSk7XG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFN0YWNrU3VwcHJlc3Npb25zKHRoaXMsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb25zIGFyZSByZXF1aXJlZCBmb3IgQ0RLIGN1c3RvbSByZXNvdXJjZSBMYW1iZGFzIHRvIGludm9rZSB0YXJnZXQgZnVuY3Rpb25zLiAnICtcbiAgICAgICAgICAgICAgICAnVGhlc2UgYXJlIGludGVybmFsIENESyBmcmFtZXdvcmsgcmVzb3VyY2VzIHdpdGggYXBwcm9wcmlhdGUgc2NvcGluZy4nLFxuICAgICAgICBhcHBsaWVzVG86IFtcbiAgICAgICAgICBgUmVzb3VyY2U6OjxMb29rdXBQcm9maWxlc0Z1bmN0aW9uJHtsb29rdXBQcm9maWxlc0Z1bmN0aW9uLm5vZGUuYWRkcn0uQXJuPjoqYCxcbiAgICAgICAgICBgUmVzb3VyY2U6OjxDb25maWd1cmVDb250YWN0TGVuc0Z1bmN0aW9uJHtjb25maWd1cmVDb250YWN0TGVuc0Z1bmN0aW9uLm5vZGUuYWRkcn0uQXJuPjoqYCxcbiAgICAgICAgICAnUmVzb3VyY2U6OmFybjphd3M6aWFtOjoqOnJvbGUvYXdzLXNlcnZpY2Utcm9sZS9jb25uZWN0LmFtYXpvbmF3cy5jb20vQVdTU2VydmljZVJvbGVGb3JBbWF6b25Db25uZWN0KicsXG4gICAgICAgICAgJ1Jlc291cmNlOjoqJyxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgXSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnNCeVBhdGgoXG4gICAgICB0aGlzLFxuICAgICAgJy9TY2FDb25uZWN0U3RhY2svTG9va3VwUHJvZmlsZXNQcm92aWRlci9mcmFtZXdvcmstb25FdmVudC9TZXJ2aWNlUm9sZS9EZWZhdWx0UG9saWN5L1Jlc291cmNlJyxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLFxuICAgICAgICAgIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb24gcmVxdWlyZWQgYnkgQ0RLIFByb3ZpZGVyIGZyYW1ld29yayB0byBpbnZva2UgdGhlIGN1c3RvbSByZXNvdXJjZSBoYW5kbGVyIGZ1bmN0aW9uIHdpdGggdmVyc2lvbmluZyBzdXBwb3J0LicsXG4gICAgICAgICAgYXBwbGllc1RvOiBbJ1Jlc291cmNlOjo8TG9va3VwUHJvZmlsZXNGdW5jdGlvbjQxRjdGODcwLkFybj46KiddLFxuICAgICAgICB9LFxuICAgICAgXVxuICAgICk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnNCeVBhdGgoXG4gICAgICB0aGlzLFxuICAgICAgJy9TY2FDb25uZWN0U3RhY2svQ29uZmlndXJlQ29udGFjdExlbnNQcm92aWRlci9mcmFtZXdvcmstb25FdmVudC9TZXJ2aWNlUm9sZS9EZWZhdWx0UG9saWN5L1Jlc291cmNlJyxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLFxuICAgICAgICAgIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb24gcmVxdWlyZWQgYnkgQ0RLIFByb3ZpZGVyIGZyYW1ld29yayB0byBpbnZva2UgdGhlIGN1c3RvbSByZXNvdXJjZSBoYW5kbGVyIGZ1bmN0aW9uIHdpdGggdmVyc2lvbmluZyBzdXBwb3J0LicsXG4gICAgICAgICAgYXBwbGllc1RvOiBbJ1Jlc291cmNlOjo8Q29uZmlndXJlQ29udGFjdExlbnNGdW5jdGlvbjdCREU0REY5LkFybj46KiddLFxuICAgICAgICB9LFxuICAgICAgXVxuICAgICk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnNCeVBhdGgoXG4gICAgICB0aGlzLFxuICAgICAgJy9TY2FDb25uZWN0U3RhY2svQWRtaW5QYXNzd29yZC9SZXNvdXJjZScsXG4gICAgICBbXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1TTUc0JyxcbiAgICAgICAgICByZWFzb246ICdBZG1pbiBwYXNzd29yZCBpcyBhIHRlbXBvcmFyeSBjcmVkZW50aWFsIGZvciBpbml0aWFsIEFtYXpvbiBDb25uZWN0IHNldHVwLiAnICtcbiAgICAgICAgICAgICAgICAgICdJdCBzaG91bGQgYmUgY2hhbmdlZCBpbW1lZGlhdGVseSBhZnRlciBmaXJzdCBsb2dpbiBhbmQgaXMgbm90IHVzZWQgaW4gcHJvZHVjdGlvbi4nLFxuICAgICAgICB9LFxuICAgICAgXVxuICAgICk7XG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zQnlQYXRoKFxuICAgICAgdGhpcyxcbiAgICAgIGAvJHtpZH0vUzNBbmFseXRpY3NQcm9jZXNzb3IvU2VydmljZVJvbGUvRGVmYXVsdFBvbGljeS9SZXNvdXJjZWAsXG4gICAgICBbXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JyxcbiAgICAgICAgICByZWFzb246ICdTMyByZWFkIHBlcm1pc3Npb25zIHdpdGggd2lsZGNhcmRzIGFyZSByZXF1aXJlZCBieSBDREsgZ3JhbnRSZWFkKCkgZm9yIHJlYWRpbmcgYW5hbHlzaXMgZmlsZXMgZnJvbSB0aGUgY2FsbCByZWNvcmRpbmcgYnVja2V0LicsXG4gICAgICAgICAgYXBwbGllc1RvOiBbXG4gICAgICAgICAgICAnQWN0aW9uOjpzMzpHZXRCdWNrZXQqJyxcbiAgICAgICAgICAgICdBY3Rpb246OnMzOkdldE9iamVjdConLFxuICAgICAgICAgICAgJ0FjdGlvbjo6czM6TGlzdConLFxuICAgICAgICAgICAgJ1Jlc291cmNlOjo8Q2FsbFJlY29yZGluZ0J1Y2tldEMxNDVBQzdGLkFybj4vKicsXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIF1cbiAgICApO1xuICB9XG59XG4iXX0=