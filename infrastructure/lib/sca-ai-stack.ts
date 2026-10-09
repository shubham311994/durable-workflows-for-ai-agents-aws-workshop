import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as lex from 'aws-cdk-lib/aws-lex';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as wisdom from 'aws-cdk-lib/aws-wisdom';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

// Load shared config (powertools layer version, etc.)
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));

export interface ScaAiStackProps extends cdk.StackProps {
  lexBotName?: string;
  assistantName?: string;
  promptModelId?: string;
  connectInstanceArn: string;
  phoneNumberArn: string;
  /**
   * REST API ID of the backend data-retrieval API. Used only to scope the
   * lambda:InvokeFunction permission granted to API Gateway for the chat/voice
   * Lambdas (which the backend API invokes via stage-variable integration).
   */
  dataRetrievalApiId?: string;
}

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
];

export class ScaAiStack extends cdk.Stack {
  public readonly lexBotAliasArn: string;
  public readonly wisdomAssistantArn: string;
  public readonly welcomeAgentVersionArn: string;
  public readonly intakeAgentVersionArn: string;
  public readonly contactFlowId: string;

  constructor(scope: Construct, id: string, props: ScaAiStackProps) {
    super(scope, id, props);

    const lexBotName = props.lexBotName ?? 'HealthInsuranceBotV2';
    const assistantName = props.assistantName ?? 'SCAAssistant';
    const promptModelId = props.promptModelId ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

    // ========================================
    // 1. Amazon Q in Connect (Wisdom) Assistant
    // ========================================

    const assistant = new wisdom.CfnAssistant(this, 'WisdomAssistant', {
      name: assistantName,
      type: 'AGENT',
      description: 'Amazon Q in Connect assistant for the SCA contact flow',
    });

    this.wisdomAssistantArn = assistant.attrAssistantArn;

    const connectInstanceId = cdk.Fn.select(1, cdk.Fn.split('instance/', props.connectInstanceArn));
    const wisdomAssociation = new cr.AwsCustomResource(this, 'WisdomConnectAssociation', {
      onCreate: {
        service: 'Connect',
        action: 'createIntegrationAssociation',
        parameters: {
          InstanceId: connectInstanceId,
          IntegrationType: 'WISDOM_ASSISTANT',
          IntegrationArn: assistant.attrAssistantArn,
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse('IntegrationAssociationId'),
      },
      onDelete: {
        service: 'Connect',
        action: 'deleteIntegrationAssociation',
        parameters: {
          InstanceId: connectInstanceId,
          IntegrationAssociationId: new cr.PhysicalResourceIdReference(),
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['connect:CreateIntegrationAssociation', 'connect:DeleteIntegrationAssociation'],
          resources: [props.connectInstanceArn, `${props.connectInstanceArn}/*`],
        }),
        new iam.PolicyStatement({
          actions: ['wisdom:GetAssistant', 'wisdom:TagResource'],
          resources: [assistant.attrAssistantArn],
        }),
        new iam.PolicyStatement({
          actions: ['iam:PutRolePolicy', 'iam:DeleteRolePolicy'],
          resources: [`arn:aws:iam::${this.account}:role/aws-service-role/connect.amazonaws.com/*`],
        }),
      ]),
    });

    // ========================================
    // 2. AI Prompts (ORCHESTRATION type)
    // ========================================

    const welcomePromptText = fs.readFileSync(
      path.join(__dirname, 'prompts', 'welcome-agent-prompt.yaml'), 'utf-8'
    );

    const welcomePrompt = new wisdom.CfnAIPrompt(this, 'WelcomeAgentPrompt', {
      assistantId: assistant.attrAssistantId,
      name: 'WelcomeAgentPrompt',
      apiFormat: 'MESSAGES',
      modelId: promptModelId,
      templateType: 'TEXT',
      type: 'ORCHESTRATION',
      description: 'Orchestration prompt for the Welcome AI agent',
      templateConfiguration: {
        textFullAiPromptEditTemplateConfiguration: { text: welcomePromptText },
      },
    });
    welcomePrompt.addDependency(assistant);

    const intakePromptText = fs.readFileSync(
      path.join(__dirname, 'prompts', 'intake-agent-prompt.yaml'), 'utf-8'
    );

    const intakePrompt = new wisdom.CfnAIPrompt(this, 'InTakeAgentPrompt', {
      assistantId: assistant.attrAssistantId,
      name: 'InTakeAgentPrompt',
      apiFormat: 'MESSAGES',
      modelId: promptModelId,
      templateType: 'TEXT',
      type: 'ORCHESTRATION',
      description: 'Orchestration prompt for the InTake AI agent',
      templateConfiguration: {
        textFullAiPromptEditTemplateConfiguration: { text: intakePromptText },
      },
    });
    intakePrompt.addDependency(assistant);

    // ========================================
    // 3. AI Agents (ORCHESTRATION type with tool configs)
    // ========================================

    const completeTool: wisdom.CfnAIAgent.ToolConfigurationProperty = {
      toolName: 'Complete',
      toolType: 'RETURN_TO_CONTROL',
      description: 'Close conversation when customer has no more questions',
      instruction: {
        instruction: 'Mark the conversation as complete ONLY after confirming the customer has no additional questions or needs. Always ask if there\'s anything else you can help with before using this tool.',
      },
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Reason of completion' } },
        required: ['reason'],
      },
      userInteractionConfiguration: { isUserConfirmationRequired: false },
    };

    const escalateTool: wisdom.CfnAIAgent.ToolConfigurationProperty = {
      toolName: 'Escalate',
      toolType: 'RETURN_TO_CONTROL',
      description: 'Escalate to human agent when customer issue can not solve',
      instruction: {
        instruction: 'Escalate the conversation to a human agent when you cannot provide adequate assistance, when other tools fail or return errors, or when the customer\'s request requires human intervention.',
      },
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Reason of escalation' } },
        required: ['reason'],
      },
      userInteractionConfiguration: { isUserConfirmationRequired: false },
    };

    const welcomeAgent = new wisdom.CfnAIAgent(this, 'WelcomeAIAgent', {
      assistantId: assistant.attrAssistantId,
      name: 'WelcomeAgent',
      type: 'ORCHESTRATION',
      description: 'Greets callers and captures their state of residence',
      configuration: {
        orchestrationAiAgentConfiguration: {
          orchestrationAiPromptId: welcomePrompt.attrAiPromptId,
          connectInstanceArn: props.connectInstanceArn,
          locale: 'en_US',
          toolConfigurations: [
            completeTool,
            escalateTool,
            {
              toolName: 'MoveToInfoCollection',
              toolType: 'RETURN_TO_CONTROL',
              toolId: 'MoveToInfoCollection',
              description: 'Transition to intake after capturing preferred language',
              instruction: {
                instruction: 'Only use this tool if you retrieved the preferred language of the caller. The user will say either English (en-US) or Spanish (es-US).',
              },
              inputSchema: {
                type: 'object',
                properties: {
                  preferredLanguage: {
                    type: 'string',
                    description: 'Preferred language of the caller (en-US for English and es-US for Spanish)',
                    enum: ['en-US', 'es-US'],
                  },
                },
                required: ['preferredLanguage'],
              },
              userInteractionConfiguration: { isUserConfirmationRequired: false },
            },
          ],
        },
      },
    });
    welcomeAgent.addDependency(welcomePrompt);
    welcomeAgent.node.addDependency(wisdomAssociation);

    const intakeAgent = new wisdom.CfnAIAgent(this, 'InTakeAIAgent', {
      assistantId: assistant.attrAssistantId,
      name: 'InTakeAgent',
      type: 'ORCHESTRATION',
      description: 'Collects caller information and determines enrollment eligibility',
      configuration: {
        orchestrationAiAgentConfiguration: {
          orchestrationAiPromptId: intakePrompt.attrAiPromptId,
          connectInstanceArn: props.connectInstanceArn,
          locale: 'en_US',
          toolConfigurations: [
            completeTool,
            escalateTool,
            {
              toolName: 'TransferHumanAgent',
              toolType: 'RETURN_TO_CONTROL',
              toolId: 'TransferHumanAgent',
              description: 'Transfer the call to a human agent once all basic information is collected',
              instruction: {
                instruction: 'Use this tool to transfer the call to a human agent once all the basic information from the user are collected.',
              },
              inputSchema: {
                type: 'object',
                properties: {
                  contactId: { type: 'string', description: 'Identifier of the current contact' },
                  state: { type: 'string', description: 'State where the caller resides' },
                  medicareEligible: { type: 'string', description: 'Whether the caller is eligible for Medicare', enum: ['yes', 'no', 'unknown'] },
                  medicareParts: { type: 'string', description: 'Which Medicare parts the caller has: Part A, Part B, both, or none. Only applicable if medicareEligible is yes.' },
                  firstName: { type: 'string', description: 'Caller\'s legal first name' },
                  lastName: { type: 'string', description: 'Caller\'s legal last name' },
                  residentialAddress: { type: 'string', description: 'Caller\'s full residential address' },
                  dateOfBirth: { type: 'string', description: 'Caller\'s date of birth in MM/DD/YYYY format' },
                  reason: { type: 'string', description: 'Reason why the caller is reaching out' },
                },
                required: ['contactId', 'state', 'medicareEligible', 'firstName', 'lastName', 'residentialAddress', 'dateOfBirth', 'reason'],
              },
              userInteractionConfiguration: { isUserConfirmationRequired: false },
            },
          ],
        },
      },
    });
    intakeAgent.addDependency(intakePrompt);
    intakeAgent.node.addDependency(wisdomAssociation);

    this.welcomeAgentVersionArn = welcomeAgent.attrAiAgentArn;
    this.intakeAgentVersionArn = intakeAgent.attrAiAgentArn;

    // ========================================
    // 4. Lex V2 Bot — uses AMAZON.QInConnectIntent
    // ========================================

    const botRole = new iam.Role(this, 'LexBotRole', {
      assumedBy: new iam.ServicePrincipal('lexv2.amazonaws.com'),
      description: 'Role for the SCA Lex V2 bot',
    });

    botRole.addToPolicy(new iam.PolicyStatement({
      actions: ['polly:SynthesizeSpeech'],
      resources: ['*'],
    }));

    botRole.addToPolicy(new iam.PolicyStatement({
      actions: ['comprehend:DetectSentiment'],
      resources: ['*'],
    }));

    botRole.addToPolicy(new iam.PolicyStatement({
      sid: 'QInConnectAssistantPolicy',
      actions: ['wisdom:CreateSession', 'wisdom:GetAssistant'],
      resources: [assistant.attrAssistantArn, `${assistant.attrAssistantArn}/*`],
    }));

    botRole.addToPolicy(new iam.PolicyStatement({
      sid: 'QInConnectSessionsPolicy',
      actions: ['wisdom:SendMessage', 'wisdom:GetNextMessage'],
      resources: [`arn:aws:wisdom:*:${this.account}:session/${assistant.attrAssistantId}/*`],
    }));

    botRole.addToPolicy(new iam.PolicyStatement({
      sid: 'LexAsyncRecognition',
      actions: ['lex:RecognizeUtterance', 'lex:RecognizeText'],
      resources: ['*'],
    }));

    const buildLocaleIntents = (): lex.CfnBot.IntentProperty[] => [
      {
        name: 'AmazonQinConnect',
        description: 'Leverages Amazon Q in Connect to fulfill requests',
        parentIntentSignature: 'AMAZON.QInConnectIntent',
        qInConnectIntentConfiguration: {
          qInConnectAssistantConfiguration: { assistantArn: assistant.attrAssistantArn },
        },
      },
      {
        name: 'FallbackIntent',
        description: 'Default fallback intent',
        parentIntentSignature: 'AMAZON.FallbackIntent',
      },
    ];

    const bot = new lex.CfnBot(this, 'HealthInsuranceBot', {
      name: lexBotName,
      roleArn: botRole.roleArn,
      dataPrivacy: { ChildDirected: false },
      idleSessionTtlInSeconds: 300,
      description: 'Health insurance bot powered by Amazon Q in Connect',
      autoBuildBotLocales: true,
      botLocales: [
        {
          localeId: 'en_US',
          description: 'English US locale',
          nluConfidenceThreshold: 0.4,
          voiceSettings: { voiceId: 'Tiffany', engine: 'generative' },
          speechDetectionSensitivity: 'MaximumNoiseTolerance',
          intents: buildLocaleIntents(),
        },
        {
          localeId: 'es_US',
          description: 'Spanish US locale',
          nluConfidenceThreshold: 0.4,
          voiceSettings: { voiceId: 'Lupe', engine: 'generative' },
          speechDetectionSensitivity: 'MaximumNoiseTolerance',
          intents: buildLocaleIntents(),
        },
      ],
    });
    bot.addDependency(assistant);

    const botVersion = new lex.CfnBotVersion(this, 'BotVersion', {
      botId: bot.attrId,
      botVersionLocaleSpecification: [
        { localeId: 'en_US', botVersionLocaleDetails: { sourceBotVersion: 'DRAFT' } },
        { localeId: 'es_US', botVersionLocaleDetails: { sourceBotVersion: 'DRAFT' } },
      ],
      description: 'Initial version',
    });
    botVersion.addDependency(bot);

    const botAlias = new lex.CfnBotAlias(this, 'BotAlias', {
      botId: bot.attrId,
      botAliasName: 'ScaBotAlias',
      botVersion: botVersion.attrBotVersion,
      description: 'Alias for the health insurance bot',
      botAliasLocaleSettings: [
        { localeId: 'en_US', botAliasLocaleSetting: { enabled: true } },
        { localeId: 'es_US', botAliasLocaleSetting: { enabled: true } },
      ],
    });
    botAlias.addDependency(botVersion);

    this.lexBotAliasArn = botAlias.attrArn;

    // ========================================
    // 5. Contact Flow + Lex Bot Association + Phone Number Association
    // ========================================

    const lexBotAssociation = new connect.CfnIntegrationAssociation(this, 'LexBotAssociation', {
      instanceId: props.connectInstanceArn,
      integrationType: 'LEX_BOT',
      integrationArn: this.lexBotAliasArn,
    });

    // Eligibility Checker Lambda (Durable)
    const eligibilityCheckerFunction = new lambda.Function(this, 'EligibilityChecker', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset('backend/eligibility-checker', {
        bundling: {
          image: lambda.Runtime.PYTHON_3_13.bundlingImage,
          command: ['bash', '-c', 'pip install -r requirements.txt -t /asset-output && cp -r . /asset-output'],
        },
      }),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        CONTACTS_TABLE: 'sca-analytics',
        POWERTOOLS_SERVICE_NAME: 'eligibility-checker',
        POWERTOOLS_METRICS_NAMESPACE: 'SCA',
        LOG_LEVEL: 'INFO',
      },
      tracing: lambda.Tracing.ACTIVE,
      durableConfig: {
        executionTimeout: cdk.Duration.minutes(5),
        retentionPeriod: cdk.Duration.days(7),
      },
    });

    eligibilityCheckerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/sca-analytics`],
    }));

    eligibilityCheckerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }));

    eligibilityCheckerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['geo-places:Geocode'],
      resources: ['*'],
    }));


    eligibilityCheckerFunction.addPermission('ConnectInvoke', {
      principal: new iam.ServicePrincipal('connect.amazonaws.com'),
      sourceArn: props.connectInstanceArn,
    });

    const eligibilityCheckerAlias = new lambda.Alias(this, 'EligibilityCheckerAlias', {
      aliasName: 'live',
      version: eligibilityCheckerFunction.latestVersion,
    });

    eligibilityCheckerAlias.addPermission('ConnectInvokeAlias', {
      principal: new iam.ServicePrincipal('connect.amazonaws.com'),
      sourceArn: props.connectInstanceArn,
    });

    const eligibilityCheckerArn = eligibilityCheckerAlias.functionArn;

    // UpdateSessionData Lambda — updates Wisdom session with preferred language
    const updateSessionDataFunction = new lambda.Function(this, 'UpdateSessionDataFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset('backend/update-session-data'),
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: {
        POWERTOOLS_SERVICE_NAME: 'update-session-data',
        LOG_LEVEL: 'INFO',
      },
    });

    updateSessionDataFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['wisdom:UpdateSessionData', 'qconnect:UpdateSessionData'],
      resources: [
        `arn:aws:wisdom:${this.region}:${this.account}:session/${assistant.attrAssistantId}/*`,
      ],
    }));

    updateSessionDataFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['connect:DescribeContact'],
      resources: [`${props.connectInstanceArn}/*`],
    }));

    updateSessionDataFunction.addPermission('ConnectInvoke', {
      principal: new iam.ServicePrincipal('connect.amazonaws.com'),
      sourceArn: props.connectInstanceArn,
    });

    const updateSessionLambdaAssociation = new connect.CfnIntegrationAssociation(this, 'UpdateSessionLambdaAssociation', {
      instanceId: props.connectInstanceArn,
      integrationType: 'LAMBDA_FUNCTION',
      integrationArn: updateSessionDataFunction.functionArn,
    });

    const updateSessionDataArn = updateSessionDataFunction.functionArn;

    const lambdaAssociation = new connect.CfnIntegrationAssociation(this, 'EligibilityLambdaAssociation', {
      instanceId: props.connectInstanceArn,
      integrationType: 'LAMBDA_FUNCTION',
      integrationArn: eligibilityCheckerArn,
    });

    // Load contact flow from external JSON config and replace placeholders
    const contactFlowContent = fs.readFileSync(
      path.join(__dirname, 'contact-flows', 'inbound-sales-flow.json'), 'utf-8'
    )
      .replace(/\{\{WISDOM_ASSISTANT_ARN\}\}/g, this.wisdomAssistantArn)
      .replace(/\{\{WELCOME_AGENT_ARN\}\}/g, this.welcomeAgentVersionArn)
      .replace(/\{\{INTAKE_AGENT_ARN\}\}/g, this.intakeAgentVersionArn)
      .replace(/\{\{LEX_BOT_ALIAS_ARN\}\}/g, this.lexBotAliasArn)
      .replace(/\{\{ELIGIBILITY_CHECKER_ARN\}\}/g, eligibilityCheckerArn)
      .replace(/\{\{UPDATE_SESSION_DATA_ARN\}\}/g, updateSessionDataArn);

    const contactFlow = new connect.CfnContactFlow(this, 'InboundContactFlow', {
      instanceArn: props.connectInstanceArn,
      type: 'CONTACT_FLOW',
      content: contactFlowContent,
      name: 'SCA-Inbound-Sales-Flow',
      description: 'Inbound sales flow with AI agents, Lex bot, recording, and analytics',
    });

    contactFlow.addDependency(lexBotAssociation);

    // Expose the created contact flow ID (used by the chat/voice Lambdas below).
    this.contactFlowId = cdk.Fn.select(3, cdk.Fn.split('/', contactFlow.attrContactFlowArn));

    // ========================================
    // In-app Chat + WebRTC Voice Lambdas
    // ========================================
    // These Lambdas live here (downstream of Connect) so they can use the locally
    // created contact flow ID and the Connect instance ID with no circular dependency.
    // The backend API (ScaBackendStack) invokes them via API Gateway STAGE VARIABLES
    // that reference these functions by name, so there is no cross-stack ARN import
    // and the API can be edited without redeploying this stack.
    const startChatFunctionName: string =
      this.node.tryGetContext('startChatFunctionName') ?? 'sca-start-chat-contact';
    const startWebRtcFunctionName: string =
      this.node.tryGetContext('startWebRtcFunctionName') ?? 'sca-start-webrtc-contact';

    const powertoolsLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'PowertoolsLayerConnectContacts',
      `arn:aws:lambda:${this.region}:017000801446:layer:AWSLambdaPowertoolsPythonV3-${config.powertoolsLayer.pythonVersion}-x86_64:${config.powertoolsLayer.version}`
    );

    const connectContactEnv = {
      CONNECT_INSTANCE_ID: connectInstanceId,
      CONTACT_FLOW_ID: this.contactFlowId,
      POWERTOOLS_METRICS_NAMESPACE: 'SCA',
      LOG_LEVEL: 'INFO',
    };

    // Source ARN used to scope the API Gateway invoke permission (optional; when the
    // backend API ID is provided we scope to it, otherwise allow the apigateway service).
    const apiSourceArn = props.dataRetrievalApiId
      ? `arn:aws:execute-api:${this.region}:${this.account}:${props.dataRetrievalApiId}/*/*/*`
      : undefined;

    // --- StartChatContact Lambda (POST /chat/start) ---
    const startChatContactFunction = new lambda.Function(this, 'StartChatContact', {
      functionName: startChatFunctionName,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/start-chat-contact'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_13.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output',
          ],
        },
      }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      layers: [powertoolsLayer],
      environment: { ...connectContactEnv, POWERTOOLS_SERVICE_NAME: 'start-chat-contact' },
      tracing: lambda.Tracing.ACTIVE,
    });

    startChatContactFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['connect:StartChatContact'],
      resources: [
        props.connectInstanceArn,
        `${props.connectInstanceArn}/*`,
      ],
    }));

    // Allow API Gateway (backend stage-variable integration) to invoke this function.
    startChatContactFunction.addPermission('AllowApiGatewayInvokeChat', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      ...(apiSourceArn ? { sourceArn: apiSourceArn } : {}),
    });

    // --- StartWebRTCContact Lambda (POST /call/start) ---
    const startWebRtcContactFunction = new lambda.Function(this, 'StartWebRTCContact', {
      functionName: startWebRtcFunctionName,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/start-webrtc-contact'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_13.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output',
          ],
        },
      }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      layers: [powertoolsLayer],
      environment: { ...connectContactEnv, POWERTOOLS_SERVICE_NAME: 'start-webrtc-contact' },
      tracing: lambda.Tracing.ACTIVE,
    });

    startWebRtcContactFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['connect:StartWebRTCContact'],
      resources: [
        props.connectInstanceArn,
        `${props.connectInstanceArn}/*`,
      ],
    }));

    startWebRtcContactFunction.addPermission('AllowApiGatewayInvokeCall', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      ...(apiSourceArn ? { sourceArn: apiSourceArn } : {}),
    });

    // CDK Nag suppressions for the two connect-contact Lambdas
    for (const fnId of ['StartChatContact', 'StartWebRTCContact']) {
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        `/ScaAiStack/${fnId}/ServiceRole/Resource`,
        [
          {
            id: 'AwsSolutions-IAM4',
            reason: 'AWSLambdaBasicExecutionRole is the AWS recommended managed policy for Lambda functions.',
            appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
          },
        ]
      );
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        `/ScaAiStack/${fnId}/ServiceRole/DefaultPolicy/Resource`,
        [
          {
            id: 'AwsSolutions-IAM5',
            reason: 'Connect StartChatContact/StartWebRTCContact require wildcard on instance sub-resources ' +
                    '(contact-flow/*, contact/*). X-Ray tracing also requires Resource::* for PutTraceSegments and PutTelemetryRecords.',
            appliesTo: [
              { regex: '/^Resource::arn:aws:connect:.+:\\d{12}:instance\\/.+\\/\\*$/' },
              'Resource::*',
            ],
          },
        ]
      );
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        `/ScaAiStack/${fnId}/Resource`,
        [
          {
            id: 'AwsSolutions-L1',
            reason: 'Lambda function is using Python 3.13, which is the latest available runtime version.',
          },
        ]
      );
    }

    new cdk.CfnOutput(this, 'StartChatContactFunctionName', {
      value: startChatContactFunction.functionName,
      description: 'StartChatContact Lambda function name (backend stage variable startChatFn)',
    });
    new cdk.CfnOutput(this, 'StartWebRTCContactFunctionName', {
      value: startWebRtcContactFunction.functionName,
      description: 'StartWebRTCContact Lambda function name (backend stage variable startWebRtcFn)',
    });
    new cdk.CfnOutput(this, 'ContactFlowId', {
      value: this.contactFlowId,
      description: 'SCA-Inbound-Sales-Flow contact flow ID',
    });

    // Associate phone number with contact flow
    const associatePhoneNumberFunction = new lambda.Function(this, 'AssociatePhoneNumberFunction', {
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
    phone_number_id = event['ResourceProperties']['PhoneNumberId']
    contact_flow_id = event['ResourceProperties']['ContactFlowId']
    physical_id = f'phone-flow-association-{phone_number_id}'
    try:
        if request_type in ('Create', 'Update'):
            response = connect.associate_phone_number_contact_flow(
                PhoneNumberId=phone_number_id, InstanceId=instance_id, ContactFlowId=contact_flow_id)
            return {'PhysicalResourceId': physical_id, 'Data': {'Status': 'Associated'}}
        elif request_type == 'Delete':
            try:
                connect.disassociate_phone_number_contact_flow(PhoneNumberId=phone_number_id, InstanceId=instance_id)
            except Exception as e:
                print(f"Error during cleanup: {e}")
            return {'PhysicalResourceId': physical_id, 'Data': {'Status': 'Disassociated'}}
    except Exception as e:
        print(f"Error: {str(e)}")
        raise
`),
    });

    associatePhoneNumberFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['connect:AssociatePhoneNumberContactFlow', 'connect:DisassociatePhoneNumberContactFlow'],
      resources: [props.phoneNumberArn, contactFlow.attrContactFlowArn],
    }));

    const associatePhoneNumberProvider = new cr.Provider(this, 'AssociatePhoneNumberProvider', {
      onEventHandler: associatePhoneNumberFunction,
    });

    const phoneNumberAssociation = new cdk.CustomResource(this, 'PhoneNumberAssociation', {
      serviceToken: associatePhoneNumberProvider.serviceToken,
      properties: {
        InstanceId: connectInstanceId,
        PhoneNumberId: cdk.Fn.select(1, cdk.Fn.split('phone-number/', props.phoneNumberArn)),
        ContactFlowId: contactFlow.attrContactFlowArn.split('/').pop(),
      },
    });
    phoneNumberAssociation.node.addDependency(contactFlow);

    // ========================================
    // Outputs
    // ========================================

    new cdk.CfnOutput(this, 'LexBotId', { value: bot.attrId, description: 'Lex V2 Bot ID' });
    new cdk.CfnOutput(this, 'LexBotAliasArn', { value: this.lexBotAliasArn, description: 'Lex V2 Bot Alias ARN' });
    new cdk.CfnOutput(this, 'WisdomAssistantArn', { value: this.wisdomAssistantArn, description: 'Amazon Q in Connect Assistant ARN' });
    new cdk.CfnOutput(this, 'WelcomeAgentArn', { value: this.welcomeAgentVersionArn, description: 'Welcome AI Agent ARN' });
    new cdk.CfnOutput(this, 'InTakeAgentArn', { value: this.intakeAgentVersionArn, description: 'InTake AI Agent ARN' });
    new cdk.CfnOutput(this, 'ContactFlowArn', { value: contactFlow.attrContactFlowArn, description: 'Contact Flow ARN' });

    // ========================================
    // CDK Nag Suppressions
    // ========================================

    NagSuppressions.addResourceSuppressionsByPath(this, `/${id}/LexBotRole/DefaultPolicy/Resource`, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Polly SynthesizeSpeech and Comprehend DetectSentiment require wildcard resource. Wisdom session resources use wildcard for dynamic session IDs.',
      },
    ]);

    NagSuppressions.addResourceSuppressionsByPath(this, `/${id}/WisdomConnectAssociation/CustomResourcePolicy/Resource`, [
      { id: 'AwsSolutions-IAM5', reason: 'Wildcard needed for Connect integration association sub-resources.' },
    ]);
    NagSuppressions.addResourceSuppressionsByPath(this, `/${id}/AWS679f53fac002430cb0da5b7982bd2287/ServiceRole/Resource`, [
      { id: 'AwsSolutions-IAM4', reason: 'AWS managed policy required for AwsCustomResource Lambda.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
    ]);
    NagSuppressions.addResourceSuppressionsByPath(this, `/${id}/AWS679f53fac002430cb0da5b7982bd2287/Resource`, [
      { id: 'AwsSolutions-L1', reason: 'Lambda runtime managed by CDK AwsCustomResource construct.' },
    ]);

    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWS managed policy AWSLambdaBasicExecutionRole is appropriate for Lambda functions.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicDurableExecutionRolePolicy',
        ],
      },
    ]);

    NagSuppressions.addStackSuppressions(this, [
      { id: 'AwsSolutions-L1', reason: 'CDK custom resource Lambdas use runtimes managed by the CDK framework.' },
    ]);

    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Wildcard permissions required for CDK custom resource Lambdas and provider framework.',
        appliesTo: [
          `Resource::<AssociatePhoneNumberFunction${associatePhoneNumberFunction.node.addr}.Arn>:*`,
          'Resource::<AssociatePhoneNumberFunctionA35F515B.Arn>:*',
          'Resource::*',
          `Resource::<WisdomAssistant.AssistantArn>/*`,
          `Resource::<ConnectInstance.Arn>/*`,
          `Resource::arn:aws:wisdom:${this.region}:${this.account}:session/<WisdomAssistant.AssistantId>/*`,
        ],
      },
    ]);
  }

}
