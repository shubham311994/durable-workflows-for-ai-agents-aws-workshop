import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

export interface ScaConnectStackProps extends cdk.StackProps {
  /**
   * Optional: Name of the Kinesis Stream for transcription ingestion
   * Defaults to 'sca-transcription-stream'
   */
  transcriptionStreamName?: string;

  /**
   * Optional: KMS key for Kinesis Stream encryption
   */
  kinesisKmsKey?: kms.IKey;
}

export class ScaConnectStack extends cdk.Stack {
  public readonly connectInstance: connect.CfnInstance;
  public readonly phoneNumber: connect.CfnPhoneNumber;
  public readonly adminCredentials: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: ScaConnectStackProps) {
    super(scope, id, props);

    const streamName = props.transcriptionStreamName ?? 'sca-transcription-stream';

    // Import the Kinesis Stream
    const transcriptionStream = kinesis.Stream.fromStreamAttributes(
      this,
      'ImportedTranscriptionStream',
      {
        streamArn: `arn:aws:kinesis:${this.region}:${this.account}:stream/${streamName}`,
      }
    );

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
    const s3EventSource = new (require('aws-cdk-lib/aws-lambda-event-sources') as typeof import('aws-cdk-lib/aws-lambda-event-sources')).S3EventSource(callRecordingBucket, {
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
      value: queue.attrQueueArn.split('/').pop()!,
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

    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWS managed policy AWSLambdaBasicExecutionRole is appropriate for Lambda functions. ' +
                'This includes CDK custom resource Lambdas that are managed by the CDK framework.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicDurableExecutionRolePolicy'],
      },
    ]);

    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-L1',
        reason: 'CDK custom resource Lambdas use runtimes managed by the CDK framework. ' +
                'These are internal implementation details and will be updated when CDK updates.',
      },
    ]);


    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-S1',
        reason: 'Call recording bucket does not require access logging for this solution.',
      },
    ]);
    NagSuppressions.addStackSuppressions(this, [
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

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaConnectStack/LookupProfilesProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource',
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Wildcard permission required by CDK Provider framework to invoke the custom resource handler function with versioning support.',
          appliesTo: ['Resource::<LookupProfilesFunction41F7F870.Arn>:*'],
        },
      ]
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaConnectStack/ConfigureContactLensProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource',
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Wildcard permission required by CDK Provider framework to invoke the custom resource handler function with versioning support.',
          appliesTo: ['Resource::<ConfigureContactLensFunction7BDE4DF9.Arn>:*'],
        },
      ]
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaConnectStack/AdminPassword/Resource',
      [
        {
          id: 'AwsSolutions-SMG4',
          reason: 'Admin password is a temporary credential for initial Amazon Connect setup. ' +
                  'It should be changed immediately after first login and is not used in production.',
        },
      ]
    );
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${id}/S3AnalyticsProcessor/ServiceRole/DefaultPolicy/Resource`,
      [
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
      ]
    );
  }
}
