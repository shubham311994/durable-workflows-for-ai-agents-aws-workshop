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
exports.ScaAiStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const connect = __importStar(require("aws-cdk-lib/aws-connect"));
const lex = __importStar(require("aws-cdk-lib/aws-lex"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const wisdom = __importStar(require("aws-cdk-lib/aws-wisdom"));
const cr = __importStar(require("aws-cdk-lib/custom-resources"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const cdk_nag_1 = require("cdk-nag");
// Load shared config (powertools layer version, etc.)
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const US_STATES = [
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
    'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
    'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
    'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
];
class ScaAiStack extends cdk.Stack {
    constructor(scope, id, props) {
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
        const welcomePromptText = fs.readFileSync(path.join(__dirname, 'prompts', 'welcome-agent-prompt.yaml'), 'utf-8');
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
        const intakePromptText = fs.readFileSync(path.join(__dirname, 'prompts', 'intake-agent-prompt.yaml'), 'utf-8');
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
        const completeTool = {
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
        const escalateTool = {
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
        const buildLocaleIntents = () => [
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
        const contactFlowContent = fs.readFileSync(path.join(__dirname, 'contact-flows', 'inbound-sales-flow.json'), 'utf-8')
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
        const startChatFunctionName = this.node.tryGetContext('startChatFunctionName') ?? 'sca-start-chat-contact';
        const startWebRtcFunctionName = this.node.tryGetContext('startWebRtcFunctionName') ?? 'sca-start-webrtc-contact';
        const powertoolsLayer = lambda.LayerVersion.fromLayerVersionArn(this, 'PowertoolsLayerConnectContacts', `arn:aws:lambda:${this.region}:017000801446:layer:AWSLambdaPowertoolsPythonV3-${config.powertoolsLayer.pythonVersion}-x86_64:${config.powertoolsLayer.version}`);
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
            cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, `/ScaAiStack/${fnId}/ServiceRole/Resource`, [
                {
                    id: 'AwsSolutions-IAM4',
                    reason: 'AWSLambdaBasicExecutionRole is the AWS recommended managed policy for Lambda functions.',
                    appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
                },
            ]);
            cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, `/ScaAiStack/${fnId}/ServiceRole/DefaultPolicy/Resource`, [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'Connect StartChatContact/StartWebRTCContact require wildcard on instance sub-resources ' +
                        '(contact-flow/*, contact/*). X-Ray tracing also requires Resource::* for PutTraceSegments and PutTelemetryRecords.',
                    appliesTo: [
                        { regex: '/^Resource::arn:aws:connect:.+:\\d{12}:instance\\/.+\\/\\*$/' },
                        'Resource::*',
                    ],
                },
            ]);
            cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, `/ScaAiStack/${fnId}/Resource`, [
                {
                    id: 'AwsSolutions-L1',
                    reason: 'Lambda function is using Python 3.13, which is the latest available runtime version.',
                },
            ]);
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
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, `/${id}/LexBotRole/DefaultPolicy/Resource`, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Polly SynthesizeSpeech and Comprehend DetectSentiment require wildcard resource. Wisdom session resources use wildcard for dynamic session IDs.',
            },
        ]);
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, `/${id}/WisdomConnectAssociation/CustomResourcePolicy/Resource`, [
            { id: 'AwsSolutions-IAM5', reason: 'Wildcard needed for Connect integration association sub-resources.' },
        ]);
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, `/${id}/AWS679f53fac002430cb0da5b7982bd2287/ServiceRole/Resource`, [
            { id: 'AwsSolutions-IAM4', reason: 'AWS managed policy required for AwsCustomResource Lambda.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
        ]);
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, `/${id}/AWS679f53fac002430cb0da5b7982bd2287/Resource`, [
            { id: 'AwsSolutions-L1', reason: 'Lambda runtime managed by CDK AwsCustomResource construct.' },
        ]);
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'AWS managed policy AWSLambdaBasicExecutionRole is appropriate for Lambda functions.',
                appliesTo: [
                    'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
                    'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicDurableExecutionRolePolicy',
                ],
            },
        ]);
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            { id: 'AwsSolutions-L1', reason: 'CDK custom resource Lambdas use runtimes managed by the CDK framework.' },
        ]);
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
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
exports.ScaAiStack = ScaAiStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NhLWFpLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vaW5mcmFzdHJ1Y3R1cmUvbGliL3NjYS1haS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMsaUVBQW1EO0FBQ25ELHlEQUEyQztBQUMzQyx5REFBMkM7QUFDM0MsK0RBQWlEO0FBQ2pELCtEQUFpRDtBQUNqRCxpRUFBbUQ7QUFDbkQsdUNBQXlCO0FBQ3pCLDJDQUE2QjtBQUU3QixxQ0FBMEM7QUFFMUMsc0RBQXNEO0FBQ3RELE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxhQUFhLENBQUMsRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDO0FBZ0J6RixNQUFNLFNBQVMsR0FBRztJQUNoQixJQUFJLEVBQUMsSUFBSSxFQUFDLElBQUksRUFBQyxJQUFJLEVBQUMsSUFBSSxFQUFDLElBQUksRUFBQyxJQUFJLEVBQUMsSUFBSSxFQUFDLElBQUksRUFBQyxJQUFJLEVBQUMsSUFBSSxFQUFDLElBQUksRUFBQyxJQUFJLEVBQUMsSUFBSSxFQUFDLElBQUk7SUFDMUUsSUFBSSxFQUFDLElBQUksRUFBQyxJQUFJLEVBQUMsSUFBSSxFQUFDLElBQUksRUFBQyxJQUFJLEVBQUMsSUFBSSxFQUFDLElBQUksRUFBQyxJQUFJLEVBQUMsSUFBSSxFQUFDLElBQUksRUFBQyxJQUFJLEVBQUMsSUFBSSxFQUFDLElBQUksRUFBQyxJQUFJO0lBQzFFLElBQUksRUFBQyxJQUFJLEVBQUMsSUFBSSxFQUFDLElBQUksRUFBQyxJQUFJLEVBQUMsSUFBSSxFQUFDLElBQUksRUFBQyxJQUFJLEVBQUMsSUFBSSxFQUFDLElBQUksRUFBQyxJQUFJLEVBQUMsSUFBSSxFQUFDLElBQUksRUFBQyxJQUFJ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RjtnQkFDN0YsU0FBUyxFQUFFO29CQUNULHVGQUF1RjtvQkFDdkYsb0dBQW9HO2lCQUNyRzthQUNGO1NBQ0YsQ0FBQyxDQUFDO1FBRUgseUJBQWUsQ0FBQyxvQkFBb0IsQ0FBQyxJQUFJLEVBQUU7WUFDekMsRUFBRSxFQUFFLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxFQUFFLHdFQUF3RSxFQUFFO1NBQzVHLENBQUMsQ0FBQztRQUVILHlCQUFlLENBQUMsb0JBQW9CLENBQUMsSUFBSSxFQUFFO1lBQ3pDO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSx1RkFBdUY7Z0JBQy9GLFNBQVMsRUFBRTtvQkFDVCwwQ0FBMEMsNEJBQTRCLENBQUMsSUFBSSxDQUFDLElBQUksU0FBUztvQkFDekYsd0RBQXdEO29CQUN4RCxhQUFhO29CQUNiLDRDQUE0QztvQkFDNUMsbUNBQW1DO29CQUNuQyw0QkFBNEIsSUFBSSxDQUFDLE1BQU0sSUFBSSxJQUFJLENBQUMsT0FBTywwQ0FBMEM7aUJBQ2xHO2FBQ0Y7U0FDRixDQUFDLENBQUM7SUFDTCxDQUFDO0NBRUY7QUFudUJELGdDQW11QkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgY29ubmVjdCBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY29ubmVjdCc7XG5pbXBvcnQgKiBhcyBsZXggZnJvbSAnYXdzLWNkay1saWIvYXdzLWxleCc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgKiBhcyB3aXNkb20gZnJvbSAnYXdzLWNkay1saWIvYXdzLXdpc2RvbSc7XG5pbXBvcnQgKiBhcyBjciBmcm9tICdhd3MtY2RrLWxpYi9jdXN0b20tcmVzb3VyY2VzJztcbmltcG9ydCAqIGFzIGZzIGZyb20gJ2ZzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7IE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gJ2Nkay1uYWcnO1xuXG4vLyBMb2FkIHNoYXJlZCBjb25maWcgKHBvd2VydG9vbHMgbGF5ZXIgdmVyc2lvbiwgZXRjLilcbmNvbnN0IGNvbmZpZyA9IEpTT04ucGFyc2UoZnMucmVhZEZpbGVTeW5jKHBhdGguam9pbihfX2Rpcm5hbWUsICdjb25maWcuanNvbicpLCAndXRmLTgnKSk7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2NhQWlTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICBsZXhCb3ROYW1lPzogc3RyaW5nO1xuICBhc3Npc3RhbnROYW1lPzogc3RyaW5nO1xuICBwcm9tcHRNb2RlbElkPzogc3RyaW5nO1xuICBjb25uZWN0SW5zdGFuY2VBcm46IHN0cmluZztcbiAgcGhvbmVOdW1iZXJBcm46IHN0cmluZztcbiAgLyoqXG4gICAqIFJFU1QgQVBJIElEIG9mIHRoZSBiYWNrZW5kIGRhdGEtcmV0cmlldmFsIEFQSS4gVXNlZCBvbmx5IHRvIHNjb3BlIHRoZVxuICAgKiBsYW1iZGE6SW52b2tlRnVuY3Rpb24gcGVybWlzc2lvbiBncmFudGVkIHRvIEFQSSBHYXRld2F5IGZvciB0aGUgY2hhdC92b2ljZVxuICAgKiBMYW1iZGFzICh3aGljaCB0aGUgYmFja2VuZCBBUEkgaW52b2tlcyB2aWEgc3RhZ2UtdmFyaWFibGUgaW50ZWdyYXRpb24pLlxuICAgKi9cbiAgZGF0YVJldHJpZXZhbEFwaUlkPzogc3RyaW5nO1xufVxuXG5jb25zdCBVU19TVEFURVMgPSBbXG4gICdBTCcsJ0FLJywnQVonLCdBUicsJ0NBJywnQ08nLCdDVCcsJ0RFJywnRkwnLCdHQScsJ0hJJywnSUQnLCdJTCcsJ0lOJywnSUEnLFxuICAnS1MnLCdLWScsJ0xBJywnTUUnLCdNRCcsJ01BJywnTUknLCdNTicsJ01TJywnTU8nLCdNVCcsJ05FJywnTlYnLCdOSCcsJ05KJyxcbiAgJ05NJywnTlknLCdOQycsJ05EJywnT0gnLCdPSycsJ09SJywnUEEnLCdSSScsJ1NDJywnU0QnLCdUTicsJ1RYJywnVVQnLCdWVCcsXG4gICdWQScsJ1dBJywnV1YnLCdXSScsJ1dZJywnREMnLFxuXTtcblxuZXhwb3J0IGNsYXNzIFNjYUFpU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgbGV4Qm90QWxpYXNBcm46IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IHdpc2RvbUFzc2lzdGFudEFybjogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgd2VsY29tZUFnZW50VmVyc2lvbkFybjogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgaW50YWtlQWdlbnRWZXJzaW9uQXJuOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBjb250YWN0Rmxvd0lkOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IFNjYUFpU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3QgbGV4Qm90TmFtZSA9IHByb3BzLmxleEJvdE5hbWUgPz8gJ0hlYWx0aEluc3VyYW5jZUJvdFYyJztcbiAgICBjb25zdCBhc3Npc3RhbnROYW1lID0gcHJvcHMuYXNzaXN0YW50TmFtZSA/PyAnU0NBQXNzaXN0YW50JztcbiAgICBjb25zdCBwcm9tcHRNb2RlbElkID0gcHJvcHMucHJvbXB0TW9kZWxJZCA/PyAndXMuYW50aHJvcGljLmNsYXVkZS1oYWlrdS00LTUtMjAyNTEwMDEtdjE6MCc7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gMS4gQW1hem9uIFEgaW4gQ29ubmVjdCAoV2lzZG9tKSBBc3Npc3RhbnRcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBjb25zdCBhc3Npc3RhbnQgPSBuZXcgd2lzZG9tLkNmbkFzc2lzdGFudCh0aGlzLCAnV2lzZG9tQXNzaXN0YW50Jywge1xuICAgICAgbmFtZTogYXNzaXN0YW50TmFtZSxcbiAgICAgIHR5cGU6ICdBR0VOVCcsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FtYXpvbiBRIGluIENvbm5lY3QgYXNzaXN0YW50IGZvciB0aGUgU0NBIGNvbnRhY3QgZmxvdycsXG4gICAgfSk7XG5cbiAgICB0aGlzLndpc2RvbUFzc2lzdGFudEFybiA9IGFzc2lzdGFudC5hdHRyQXNzaXN0YW50QXJuO1xuXG4gICAgY29uc3QgY29ubmVjdEluc3RhbmNlSWQgPSBjZGsuRm4uc2VsZWN0KDEsIGNkay5Gbi5zcGxpdCgnaW5zdGFuY2UvJywgcHJvcHMuY29ubmVjdEluc3RhbmNlQXJuKSk7XG4gICAgY29uc3Qgd2lzZG9tQXNzb2NpYXRpb24gPSBuZXcgY3IuQXdzQ3VzdG9tUmVzb3VyY2UodGhpcywgJ1dpc2RvbUNvbm5lY3RBc3NvY2lhdGlvbicsIHtcbiAgICAgIG9uQ3JlYXRlOiB7XG4gICAgICAgIHNlcnZpY2U6ICdDb25uZWN0JyxcbiAgICAgICAgYWN0aW9uOiAnY3JlYXRlSW50ZWdyYXRpb25Bc3NvY2lhdGlvbicsXG4gICAgICAgIHBhcmFtZXRlcnM6IHtcbiAgICAgICAgICBJbnN0YW5jZUlkOiBjb25uZWN0SW5zdGFuY2VJZCxcbiAgICAgICAgICBJbnRlZ3JhdGlvblR5cGU6ICdXSVNET01fQVNTSVNUQU5UJyxcbiAgICAgICAgICBJbnRlZ3JhdGlvbkFybjogYXNzaXN0YW50LmF0dHJBc3Npc3RhbnRBcm4sXG4gICAgICAgIH0sXG4gICAgICAgIHBoeXNpY2FsUmVzb3VyY2VJZDogY3IuUGh5c2ljYWxSZXNvdXJjZUlkLmZyb21SZXNwb25zZSgnSW50ZWdyYXRpb25Bc3NvY2lhdGlvbklkJyksXG4gICAgICB9LFxuICAgICAgb25EZWxldGU6IHtcbiAgICAgICAgc2VydmljZTogJ0Nvbm5lY3QnLFxuICAgICAgICBhY3Rpb246ICdkZWxldGVJbnRlZ3JhdGlvbkFzc29jaWF0aW9uJyxcbiAgICAgICAgcGFyYW1ldGVyczoge1xuICAgICAgICAgIEluc3RhbmNlSWQ6IGNvbm5lY3RJbnN0YW5jZUlkLFxuICAgICAgICAgIEludGVncmF0aW9uQXNzb2NpYXRpb25JZDogbmV3IGNyLlBoeXNpY2FsUmVzb3VyY2VJZFJlZmVyZW5jZSgpLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHBvbGljeTogY3IuQXdzQ3VzdG9tUmVzb3VyY2VQb2xpY3kuZnJvbVN0YXRlbWVudHMoW1xuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgYWN0aW9uczogWydjb25uZWN0OkNyZWF0ZUludGVncmF0aW9uQXNzb2NpYXRpb24nLCAnY29ubmVjdDpEZWxldGVJbnRlZ3JhdGlvbkFzc29jaWF0aW9uJ10sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbcHJvcHMuY29ubmVjdEluc3RhbmNlQXJuLCBgJHtwcm9wcy5jb25uZWN0SW5zdGFuY2VBcm59LypgXSxcbiAgICAgICAgfSksXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBhY3Rpb25zOiBbJ3dpc2RvbTpHZXRBc3Npc3RhbnQnLCAnd2lzZG9tOlRhZ1Jlc291cmNlJ10sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbYXNzaXN0YW50LmF0dHJBc3Npc3RhbnRBcm5dLFxuICAgICAgICB9KSxcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGFjdGlvbnM6IFsnaWFtOlB1dFJvbGVQb2xpY3knLCAnaWFtOkRlbGV0ZVJvbGVQb2xpY3knXSxcbiAgICAgICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czppYW06OiR7dGhpcy5hY2NvdW50fTpyb2xlL2F3cy1zZXJ2aWNlLXJvbGUvY29ubmVjdC5hbWF6b25hd3MuY29tLypgXSxcbiAgICAgICAgfSksXG4gICAgICBdKSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyAyLiBBSSBQcm9tcHRzIChPUkNIRVNUUkFUSU9OIHR5cGUpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3Qgd2VsY29tZVByb21wdFRleHQgPSBmcy5yZWFkRmlsZVN5bmMoXG4gICAgICBwYXRoLmpvaW4oX19kaXJuYW1lLCAncHJvbXB0cycsICd3ZWxjb21lLWFnZW50LXByb21wdC55YW1sJyksICd1dGYtOCdcbiAgICApO1xuXG4gICAgY29uc3Qgd2VsY29tZVByb21wdCA9IG5ldyB3aXNkb20uQ2ZuQUlQcm9tcHQodGhpcywgJ1dlbGNvbWVBZ2VudFByb21wdCcsIHtcbiAgICAgIGFzc2lzdGFudElkOiBhc3Npc3RhbnQuYXR0ckFzc2lzdGFudElkLFxuICAgICAgbmFtZTogJ1dlbGNvbWVBZ2VudFByb21wdCcsXG4gICAgICBhcGlGb3JtYXQ6ICdNRVNTQUdFUycsXG4gICAgICBtb2RlbElkOiBwcm9tcHRNb2RlbElkLFxuICAgICAgdGVtcGxhdGVUeXBlOiAnVEVYVCcsXG4gICAgICB0eXBlOiAnT1JDSEVTVFJBVElPTicsXG4gICAgICBkZXNjcmlwdGlvbjogJ09yY2hlc3RyYXRpb24gcHJvbXB0IGZvciB0aGUgV2VsY29tZSBBSSBhZ2VudCcsXG4gICAgICB0ZW1wbGF0ZUNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgdGV4dEZ1bGxBaVByb21wdEVkaXRUZW1wbGF0ZUNvbmZpZ3VyYXRpb246IHsgdGV4dDogd2VsY29tZVByb21wdFRleHQgfSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgd2VsY29tZVByb21wdC5hZGREZXBlbmRlbmN5KGFzc2lzdGFudCk7XG5cbiAgICBjb25zdCBpbnRha2VQcm9tcHRUZXh0ID0gZnMucmVhZEZpbGVTeW5jKFxuICAgICAgcGF0aC5qb2luKF9fZGlybmFtZSwgJ3Byb21wdHMnLCAnaW50YWtlLWFnZW50LXByb21wdC55YW1sJyksICd1dGYtOCdcbiAgICApO1xuXG4gICAgY29uc3QgaW50YWtlUHJvbXB0ID0gbmV3IHdpc2RvbS5DZm5BSVByb21wdCh0aGlzLCAnSW5UYWtlQWdlbnRQcm9tcHQnLCB7XG4gICAgICBhc3Npc3RhbnRJZDogYXNzaXN0YW50LmF0dHJBc3Npc3RhbnRJZCxcbiAgICAgIG5hbWU6ICdJblRha2VBZ2VudFByb21wdCcsXG4gICAgICBhcGlGb3JtYXQ6ICdNRVNTQUdFUycsXG4gICAgICBtb2RlbElkOiBwcm9tcHRNb2RlbElkLFxuICAgICAgdGVtcGxhdGVUeXBlOiAnVEVYVCcsXG4gICAgICB0eXBlOiAnT1JDSEVTVFJBVElPTicsXG4gICAgICBkZXNjcmlwdGlvbjogJ09yY2hlc3RyYXRpb24gcHJvbXB0IGZvciB0aGUgSW5UYWtlIEFJIGFnZW50JyxcbiAgICAgIHRlbXBsYXRlQ29uZmlndXJhdGlvbjoge1xuICAgICAgICB0ZXh0RnVsbEFpUHJvbXB0RWRpdFRlbXBsYXRlQ29uZmlndXJhdGlvbjogeyB0ZXh0OiBpbnRha2VQcm9tcHRUZXh0IH0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGludGFrZVByb21wdC5hZGREZXBlbmRlbmN5KGFzc2lzdGFudCk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gMy4gQUkgQWdlbnRzIChPUkNIRVNUUkFUSU9OIHR5cGUgd2l0aCB0b29sIGNvbmZpZ3MpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgY29tcGxldGVUb29sOiB3aXNkb20uQ2ZuQUlBZ2VudC5Ub29sQ29uZmlndXJhdGlvblByb3BlcnR5ID0ge1xuICAgICAgdG9vbE5hbWU6ICdDb21wbGV0ZScsXG4gICAgICB0b29sVHlwZTogJ1JFVFVSTl9UT19DT05UUk9MJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ2xvc2UgY29udmVyc2F0aW9uIHdoZW4gY3VzdG9tZXIgaGFzIG5vIG1vcmUgcXVlc3Rpb25zJyxcbiAgICAgIGluc3RydWN0aW9uOiB7XG4gICAgICAgIGluc3RydWN0aW9uOiAnTWFyayB0aGUgY29udmVyc2F0aW9uIGFzIGNvbXBsZXRlIE9OTFkgYWZ0ZXIgY29uZmlybWluZyB0aGUgY3VzdG9tZXIgaGFzIG5vIGFkZGl0aW9uYWwgcXVlc3Rpb25zIG9yIG5lZWRzLiBBbHdheXMgYXNrIGlmIHRoZXJlXFwncyBhbnl0aGluZyBlbHNlIHlvdSBjYW4gaGVscCB3aXRoIGJlZm9yZSB1c2luZyB0aGlzIHRvb2wuJyxcbiAgICAgIH0sXG4gICAgICBpbnB1dFNjaGVtYToge1xuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgICAgcHJvcGVydGllczogeyByZWFzb246IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnUmVhc29uIG9mIGNvbXBsZXRpb24nIH0gfSxcbiAgICAgICAgcmVxdWlyZWQ6IFsncmVhc29uJ10sXG4gICAgICB9LFxuICAgICAgdXNlckludGVyYWN0aW9uQ29uZmlndXJhdGlvbjogeyBpc1VzZXJDb25maXJtYXRpb25SZXF1aXJlZDogZmFsc2UgfSxcbiAgICB9O1xuXG4gICAgY29uc3QgZXNjYWxhdGVUb29sOiB3aXNkb20uQ2ZuQUlBZ2VudC5Ub29sQ29uZmlndXJhdGlvblByb3BlcnR5ID0ge1xuICAgICAgdG9vbE5hbWU6ICdFc2NhbGF0ZScsXG4gICAgICB0b29sVHlwZTogJ1JFVFVSTl9UT19DT05UUk9MJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRXNjYWxhdGUgdG8gaHVtYW4gYWdlbnQgd2hlbiBjdXN0b21lciBpc3N1ZSBjYW4gbm90IHNvbHZlJyxcbiAgICAgIGluc3RydWN0aW9uOiB7XG4gICAgICAgIGluc3RydWN0aW9uOiAnRXNjYWxhdGUgdGhlIGNvbnZlcnNhdGlvbiB0byBhIGh1bWFuIGFnZW50IHdoZW4geW91IGNhbm5vdCBwcm92aWRlIGFkZXF1YXRlIGFzc2lzdGFuY2UsIHdoZW4gb3RoZXIgdG9vbHMgZmFpbCBvciByZXR1cm4gZXJyb3JzLCBvciB3aGVuIHRoZSBjdXN0b21lclxcJ3MgcmVxdWVzdCByZXF1aXJlcyBodW1hbiBpbnRlcnZlbnRpb24uJyxcbiAgICAgIH0sXG4gICAgICBpbnB1dFNjaGVtYToge1xuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgICAgcHJvcGVydGllczogeyByZWFzb246IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnUmVhc29uIG9mIGVzY2FsYXRpb24nIH0gfSxcbiAgICAgICAgcmVxdWlyZWQ6IFsncmVhc29uJ10sXG4gICAgICB9LFxuICAgICAgdXNlckludGVyYWN0aW9uQ29uZmlndXJhdGlvbjogeyBpc1VzZXJDb25maXJtYXRpb25SZXF1aXJlZDogZmFsc2UgfSxcbiAgICB9O1xuXG4gICAgY29uc3Qgd2VsY29tZUFnZW50ID0gbmV3IHdpc2RvbS5DZm5BSUFnZW50KHRoaXMsICdXZWxjb21lQUlBZ2VudCcsIHtcbiAgICAgIGFzc2lzdGFudElkOiBhc3Npc3RhbnQuYXR0ckFzc2lzdGFudElkLFxuICAgICAgbmFtZTogJ1dlbGNvbWVBZ2VudCcsXG4gICAgICB0eXBlOiAnT1JDSEVTVFJBVElPTicsXG4gICAgICBkZXNjcmlwdGlvbjogJ0dyZWV0cyBjYWxsZXJzIGFuZCBjYXB0dXJlcyB0aGVpciBzdGF0ZSBvZiByZXNpZGVuY2UnLFxuICAgICAgY29uZmlndXJhdGlvbjoge1xuICAgICAgICBvcmNoZXN0cmF0aW9uQWlBZ2VudENvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBvcmNoZXN0cmF0aW9uQWlQcm9tcHRJZDogd2VsY29tZVByb21wdC5hdHRyQWlQcm9tcHRJZCxcbiAgICAgICAgICBjb25uZWN0SW5zdGFuY2VBcm46IHByb3BzLmNvbm5lY3RJbnN0YW5jZUFybixcbiAgICAgICAgICBsb2NhbGU6ICdlbl9VUycsXG4gICAgICAgICAgdG9vbENvbmZpZ3VyYXRpb25zOiBbXG4gICAgICAgICAgICBjb21wbGV0ZVRvb2wsXG4gICAgICAgICAgICBlc2NhbGF0ZVRvb2wsXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHRvb2xOYW1lOiAnTW92ZVRvSW5mb0NvbGxlY3Rpb24nLFxuICAgICAgICAgICAgICB0b29sVHlwZTogJ1JFVFVSTl9UT19DT05UUk9MJyxcbiAgICAgICAgICAgICAgdG9vbElkOiAnTW92ZVRvSW5mb0NvbGxlY3Rpb24nLFxuICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ1RyYW5zaXRpb24gdG8gaW50YWtlIGFmdGVyIGNhcHR1cmluZyBwcmVmZXJyZWQgbGFuZ3VhZ2UnLFxuICAgICAgICAgICAgICBpbnN0cnVjdGlvbjoge1xuICAgICAgICAgICAgICAgIGluc3RydWN0aW9uOiAnT25seSB1c2UgdGhpcyB0b29sIGlmIHlvdSByZXRyaWV2ZWQgdGhlIHByZWZlcnJlZCBsYW5ndWFnZSBvZiB0aGUgY2FsbGVyLiBUaGUgdXNlciB3aWxsIHNheSBlaXRoZXIgRW5nbGlzaCAoZW4tVVMpIG9yIFNwYW5pc2ggKGVzLVVTKS4nLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBpbnB1dFNjaGVtYToge1xuICAgICAgICAgICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICAgICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgICAgICAgIHByZWZlcnJlZExhbmd1YWdlOiB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGU6ICdzdHJpbmcnLFxuICAgICAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ1ByZWZlcnJlZCBsYW5ndWFnZSBvZiB0aGUgY2FsbGVyIChlbi1VUyBmb3IgRW5nbGlzaCBhbmQgZXMtVVMgZm9yIFNwYW5pc2gpJyxcbiAgICAgICAgICAgICAgICAgICAgZW51bTogWydlbi1VUycsICdlcy1VUyddLFxuICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHJlcXVpcmVkOiBbJ3ByZWZlcnJlZExhbmd1YWdlJ10sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHVzZXJJbnRlcmFjdGlvbkNvbmZpZ3VyYXRpb246IHsgaXNVc2VyQ29uZmlybWF0aW9uUmVxdWlyZWQ6IGZhbHNlIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIHdlbGNvbWVBZ2VudC5hZGREZXBlbmRlbmN5KHdlbGNvbWVQcm9tcHQpO1xuICAgIHdlbGNvbWVBZ2VudC5ub2RlLmFkZERlcGVuZGVuY3kod2lzZG9tQXNzb2NpYXRpb24pO1xuXG4gICAgY29uc3QgaW50YWtlQWdlbnQgPSBuZXcgd2lzZG9tLkNmbkFJQWdlbnQodGhpcywgJ0luVGFrZUFJQWdlbnQnLCB7XG4gICAgICBhc3Npc3RhbnRJZDogYXNzaXN0YW50LmF0dHJBc3Npc3RhbnRJZCxcbiAgICAgIG5hbWU6ICdJblRha2VBZ2VudCcsXG4gICAgICB0eXBlOiAnT1JDSEVTVFJBVElPTicsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvbGxlY3RzIGNhbGxlciBpbmZvcm1hdGlvbiBhbmQgZGV0ZXJtaW5lcyBlbnJvbGxtZW50IGVsaWdpYmlsaXR5JyxcbiAgICAgIGNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgb3JjaGVzdHJhdGlvbkFpQWdlbnRDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgb3JjaGVzdHJhdGlvbkFpUHJvbXB0SWQ6IGludGFrZVByb21wdC5hdHRyQWlQcm9tcHRJZCxcbiAgICAgICAgICBjb25uZWN0SW5zdGFuY2VBcm46IHByb3BzLmNvbm5lY3RJbnN0YW5jZUFybixcbiAgICAgICAgICBsb2NhbGU6ICdlbl9VUycsXG4gICAgICAgICAgdG9vbENvbmZpZ3VyYXRpb25zOiBbXG4gICAgICAgICAgICBjb21wbGV0ZVRvb2wsXG4gICAgICAgICAgICBlc2NhbGF0ZVRvb2wsXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHRvb2xOYW1lOiAnVHJhbnNmZXJIdW1hbkFnZW50JyxcbiAgICAgICAgICAgICAgdG9vbFR5cGU6ICdSRVRVUk5fVE9fQ09OVFJPTCcsXG4gICAgICAgICAgICAgIHRvb2xJZDogJ1RyYW5zZmVySHVtYW5BZ2VudCcsXG4gICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAnVHJhbnNmZXIgdGhlIGNhbGwgdG8gYSBodW1hbiBhZ2VudCBvbmNlIGFsbCBiYXNpYyBpbmZvcm1hdGlvbiBpcyBjb2xsZWN0ZWQnLFxuICAgICAgICAgICAgICBpbnN0cnVjdGlvbjoge1xuICAgICAgICAgICAgICAgIGluc3RydWN0aW9uOiAnVXNlIHRoaXMgdG9vbCB0byB0cmFuc2ZlciB0aGUgY2FsbCB0byBhIGh1bWFuIGFnZW50IG9uY2UgYWxsIHRoZSBiYXNpYyBpbmZvcm1hdGlvbiBmcm9tIHRoZSB1c2VyIGFyZSBjb2xsZWN0ZWQuJyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgaW5wdXRTY2hlbWE6IHtcbiAgICAgICAgICAgICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgICAgICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICAgICAgICBjb250YWN0SWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnSWRlbnRpZmllciBvZiB0aGUgY3VycmVudCBjb250YWN0JyB9LFxuICAgICAgICAgICAgICAgICAgc3RhdGU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnU3RhdGUgd2hlcmUgdGhlIGNhbGxlciByZXNpZGVzJyB9LFxuICAgICAgICAgICAgICAgICAgbWVkaWNhcmVFbGlnaWJsZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdXaGV0aGVyIHRoZSBjYWxsZXIgaXMgZWxpZ2libGUgZm9yIE1lZGljYXJlJywgZW51bTogWyd5ZXMnLCAnbm8nLCAndW5rbm93biddIH0sXG4gICAgICAgICAgICAgICAgICBtZWRpY2FyZVBhcnRzOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ1doaWNoIE1lZGljYXJlIHBhcnRzIHRoZSBjYWxsZXIgaGFzOiBQYXJ0IEEsIFBhcnQgQiwgYm90aCwgb3Igbm9uZS4gT25seSBhcHBsaWNhYmxlIGlmIG1lZGljYXJlRWxpZ2libGUgaXMgeWVzLicgfSxcbiAgICAgICAgICAgICAgICAgIGZpcnN0TmFtZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdDYWxsZXJcXCdzIGxlZ2FsIGZpcnN0IG5hbWUnIH0sXG4gICAgICAgICAgICAgICAgICBsYXN0TmFtZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdDYWxsZXJcXCdzIGxlZ2FsIGxhc3QgbmFtZScgfSxcbiAgICAgICAgICAgICAgICAgIHJlc2lkZW50aWFsQWRkcmVzczogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdDYWxsZXJcXCdzIGZ1bGwgcmVzaWRlbnRpYWwgYWRkcmVzcycgfSxcbiAgICAgICAgICAgICAgICAgIGRhdGVPZkJpcnRoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ0NhbGxlclxcJ3MgZGF0ZSBvZiBiaXJ0aCBpbiBNTS9ERC9ZWVlZIGZvcm1hdCcgfSxcbiAgICAgICAgICAgICAgICAgIHJlYXNvbjogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdSZWFzb24gd2h5IHRoZSBjYWxsZXIgaXMgcmVhY2hpbmcgb3V0JyB9LFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgcmVxdWlyZWQ6IFsnY29udGFjdElkJywgJ3N0YXRlJywgJ21lZGljYXJlRWxpZ2libGUnLCAnZmlyc3ROYW1lJywgJ2xhc3ROYW1lJywgJ3Jlc2lkZW50aWFsQWRkcmVzcycsICdkYXRlT2ZCaXJ0aCcsICdyZWFzb24nXSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgdXNlckludGVyYWN0aW9uQ29uZmlndXJhdGlvbjogeyBpc1VzZXJDb25maXJtYXRpb25SZXF1aXJlZDogZmFsc2UgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgaW50YWtlQWdlbnQuYWRkRGVwZW5kZW5jeShpbnRha2VQcm9tcHQpO1xuICAgIGludGFrZUFnZW50Lm5vZGUuYWRkRGVwZW5kZW5jeSh3aXNkb21Bc3NvY2lhdGlvbik7XG5cbiAgICB0aGlzLndlbGNvbWVBZ2VudFZlcnNpb25Bcm4gPSB3ZWxjb21lQWdlbnQuYXR0ckFpQWdlbnRBcm47XG4gICAgdGhpcy5pbnRha2VBZ2VudFZlcnNpb25Bcm4gPSBpbnRha2VBZ2VudC5hdHRyQWlBZ2VudEFybjtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyA0LiBMZXggVjIgQm90IOKAlCB1c2VzIEFNQVpPTi5RSW5Db25uZWN0SW50ZW50XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgYm90Um9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnTGV4Qm90Um9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdsZXh2Mi5hbWF6b25hd3MuY29tJyksXG4gICAgICBkZXNjcmlwdGlvbjogJ1JvbGUgZm9yIHRoZSBTQ0EgTGV4IFYyIGJvdCcsXG4gICAgfSk7XG5cbiAgICBib3RSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsncG9sbHk6U3ludGhlc2l6ZVNwZWVjaCddLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICBib3RSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnY29tcHJlaGVuZDpEZXRlY3RTZW50aW1lbnQnXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuXG4gICAgYm90Um9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBzaWQ6ICdRSW5Db25uZWN0QXNzaXN0YW50UG9saWN5JyxcbiAgICAgIGFjdGlvbnM6IFsnd2lzZG9tOkNyZWF0ZVNlc3Npb24nLCAnd2lzZG9tOkdldEFzc2lzdGFudCddLFxuICAgICAgcmVzb3VyY2VzOiBbYXNzaXN0YW50LmF0dHJBc3Npc3RhbnRBcm4sIGAke2Fzc2lzdGFudC5hdHRyQXNzaXN0YW50QXJufS8qYF0sXG4gICAgfSkpO1xuXG4gICAgYm90Um9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBzaWQ6ICdRSW5Db25uZWN0U2Vzc2lvbnNQb2xpY3knLFxuICAgICAgYWN0aW9uczogWyd3aXNkb206U2VuZE1lc3NhZ2UnLCAnd2lzZG9tOkdldE5leHRNZXNzYWdlJ10sXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czp3aXNkb206Kjoke3RoaXMuYWNjb3VudH06c2Vzc2lvbi8ke2Fzc2lzdGFudC5hdHRyQXNzaXN0YW50SWR9LypgXSxcbiAgICB9KSk7XG5cbiAgICBib3RSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIHNpZDogJ0xleEFzeW5jUmVjb2duaXRpb24nLFxuICAgICAgYWN0aW9uczogWydsZXg6UmVjb2duaXplVXR0ZXJhbmNlJywgJ2xleDpSZWNvZ25pemVUZXh0J10sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgIH0pKTtcblxuICAgIGNvbnN0IGJ1aWxkTG9jYWxlSW50ZW50cyA9ICgpOiBsZXguQ2ZuQm90LkludGVudFByb3BlcnR5W10gPT4gW1xuICAgICAge1xuICAgICAgICBuYW1lOiAnQW1hem9uUWluQ29ubmVjdCcsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnTGV2ZXJhZ2VzIEFtYXpvbiBRIGluIENvbm5lY3QgdG8gZnVsZmlsbCByZXF1ZXN0cycsXG4gICAgICAgIHBhcmVudEludGVudFNpZ25hdHVyZTogJ0FNQVpPTi5RSW5Db25uZWN0SW50ZW50JyxcbiAgICAgICAgcUluQ29ubmVjdEludGVudENvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBxSW5Db25uZWN0QXNzaXN0YW50Q29uZmlndXJhdGlvbjogeyBhc3Npc3RhbnRBcm46IGFzc2lzdGFudC5hdHRyQXNzaXN0YW50QXJuIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBuYW1lOiAnRmFsbGJhY2tJbnRlbnQnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ0RlZmF1bHQgZmFsbGJhY2sgaW50ZW50JyxcbiAgICAgICAgcGFyZW50SW50ZW50U2lnbmF0dXJlOiAnQU1BWk9OLkZhbGxiYWNrSW50ZW50JyxcbiAgICAgIH0sXG4gICAgXTtcblxuICAgIGNvbnN0IGJvdCA9IG5ldyBsZXguQ2ZuQm90KHRoaXMsICdIZWFsdGhJbnN1cmFuY2VCb3QnLCB7XG4gICAgICBuYW1lOiBsZXhCb3ROYW1lLFxuICAgICAgcm9sZUFybjogYm90Um9sZS5yb2xlQXJuLFxuICAgICAgZGF0YVByaXZhY3k6IHsgQ2hpbGREaXJlY3RlZDogZmFsc2UgfSxcbiAgICAgIGlkbGVTZXNzaW9uVHRsSW5TZWNvbmRzOiAzMDAsXG4gICAgICBkZXNjcmlwdGlvbjogJ0hlYWx0aCBpbnN1cmFuY2UgYm90IHBvd2VyZWQgYnkgQW1hem9uIFEgaW4gQ29ubmVjdCcsXG4gICAgICBhdXRvQnVpbGRCb3RMb2NhbGVzOiB0cnVlLFxuICAgICAgYm90TG9jYWxlczogW1xuICAgICAgICB7XG4gICAgICAgICAgbG9jYWxlSWQ6ICdlbl9VUycsXG4gICAgICAgICAgZGVzY3JpcHRpb246ICdFbmdsaXNoIFVTIGxvY2FsZScsXG4gICAgICAgICAgbmx1Q29uZmlkZW5jZVRocmVzaG9sZDogMC40LFxuICAgICAgICAgIHZvaWNlU2V0dGluZ3M6IHsgdm9pY2VJZDogJ1RpZmZhbnknLCBlbmdpbmU6ICdnZW5lcmF0aXZlJyB9LFxuICAgICAgICAgIHNwZWVjaERldGVjdGlvblNlbnNpdGl2aXR5OiAnTWF4aW11bU5vaXNlVG9sZXJhbmNlJyxcbiAgICAgICAgICBpbnRlbnRzOiBidWlsZExvY2FsZUludGVudHMoKSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGxvY2FsZUlkOiAnZXNfVVMnLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiAnU3BhbmlzaCBVUyBsb2NhbGUnLFxuICAgICAgICAgIG5sdUNvbmZpZGVuY2VUaHJlc2hvbGQ6IDAuNCxcbiAgICAgICAgICB2b2ljZVNldHRpbmdzOiB7IHZvaWNlSWQ6ICdMdXBlJywgZW5naW5lOiAnZ2VuZXJhdGl2ZScgfSxcbiAgICAgICAgICBzcGVlY2hEZXRlY3Rpb25TZW5zaXRpdml0eTogJ01heGltdW1Ob2lzZVRvbGVyYW5jZScsXG4gICAgICAgICAgaW50ZW50czogYnVpbGRMb2NhbGVJbnRlbnRzKCksXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuICAgIGJvdC5hZGREZXBlbmRlbmN5KGFzc2lzdGFudCk7XG5cbiAgICBjb25zdCBib3RWZXJzaW9uID0gbmV3IGxleC5DZm5Cb3RWZXJzaW9uKHRoaXMsICdCb3RWZXJzaW9uJywge1xuICAgICAgYm90SWQ6IGJvdC5hdHRySWQsXG4gICAgICBib3RWZXJzaW9uTG9jYWxlU3BlY2lmaWNhdGlvbjogW1xuICAgICAgICB7IGxvY2FsZUlkOiAnZW5fVVMnLCBib3RWZXJzaW9uTG9jYWxlRGV0YWlsczogeyBzb3VyY2VCb3RWZXJzaW9uOiAnRFJBRlQnIH0gfSxcbiAgICAgICAgeyBsb2NhbGVJZDogJ2VzX1VTJywgYm90VmVyc2lvbkxvY2FsZURldGFpbHM6IHsgc291cmNlQm90VmVyc2lvbjogJ0RSQUZUJyB9IH0sXG4gICAgICBdLFxuICAgICAgZGVzY3JpcHRpb246ICdJbml0aWFsIHZlcnNpb24nLFxuICAgIH0pO1xuICAgIGJvdFZlcnNpb24uYWRkRGVwZW5kZW5jeShib3QpO1xuXG4gICAgY29uc3QgYm90QWxpYXMgPSBuZXcgbGV4LkNmbkJvdEFsaWFzKHRoaXMsICdCb3RBbGlhcycsIHtcbiAgICAgIGJvdElkOiBib3QuYXR0cklkLFxuICAgICAgYm90QWxpYXNOYW1lOiAnU2NhQm90QWxpYXMnLFxuICAgICAgYm90VmVyc2lvbjogYm90VmVyc2lvbi5hdHRyQm90VmVyc2lvbixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQWxpYXMgZm9yIHRoZSBoZWFsdGggaW5zdXJhbmNlIGJvdCcsXG4gICAgICBib3RBbGlhc0xvY2FsZVNldHRpbmdzOiBbXG4gICAgICAgIHsgbG9jYWxlSWQ6ICdlbl9VUycsIGJvdEFsaWFzTG9jYWxlU2V0dGluZzogeyBlbmFibGVkOiB0cnVlIH0gfSxcbiAgICAgICAgeyBsb2NhbGVJZDogJ2VzX1VTJywgYm90QWxpYXNMb2NhbGVTZXR0aW5nOiB7IGVuYWJsZWQ6IHRydWUgfSB9LFxuICAgICAgXSxcbiAgICB9KTtcbiAgICBib3RBbGlhcy5hZGREZXBlbmRlbmN5KGJvdFZlcnNpb24pO1xuXG4gICAgdGhpcy5sZXhCb3RBbGlhc0FybiA9IGJvdEFsaWFzLmF0dHJBcm47XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gNS4gQ29udGFjdCBGbG93ICsgTGV4IEJvdCBBc3NvY2lhdGlvbiArIFBob25lIE51bWJlciBBc3NvY2lhdGlvblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IGxleEJvdEFzc29jaWF0aW9uID0gbmV3IGNvbm5lY3QuQ2ZuSW50ZWdyYXRpb25Bc3NvY2lhdGlvbih0aGlzLCAnTGV4Qm90QXNzb2NpYXRpb24nLCB7XG4gICAgICBpbnN0YW5jZUlkOiBwcm9wcy5jb25uZWN0SW5zdGFuY2VBcm4sXG4gICAgICBpbnRlZ3JhdGlvblR5cGU6ICdMRVhfQk9UJyxcbiAgICAgIGludGVncmF0aW9uQXJuOiB0aGlzLmxleEJvdEFsaWFzQXJuLFxuICAgIH0pO1xuXG4gICAgLy8gRWxpZ2liaWxpdHkgQ2hlY2tlciBMYW1iZGEgKER1cmFibGUpXG4gICAgY29uc3QgZWxpZ2liaWxpdHlDaGVja2VyRnVuY3Rpb24gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdFbGlnaWJpbGl0eUNoZWNrZXInLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMyxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyLmxhbWJkYV9oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldCgnYmFja2VuZC9lbGlnaWJpbGl0eS1jaGVja2VyJywge1xuICAgICAgICBidW5kbGluZzoge1xuICAgICAgICAgIGltYWdlOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMy5idW5kbGluZ0ltYWdlLFxuICAgICAgICAgIGNvbW1hbmQ6IFsnYmFzaCcsICctYycsICdwaXAgaW5zdGFsbCAtciByZXF1aXJlbWVudHMudHh0IC10IC9hc3NldC1vdXRwdXQgJiYgY3AgLXIgLiAvYXNzZXQtb3V0cHV0J10sXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgbWVtb3J5U2l6ZTogNTEyLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ09OVEFDVFNfVEFCTEU6ICdzY2EtYW5hbHl0aWNzJyxcbiAgICAgICAgUE9XRVJUT09MU19TRVJWSUNFX05BTUU6ICdlbGlnaWJpbGl0eS1jaGVja2VyJyxcbiAgICAgICAgUE9XRVJUT09MU19NRVRSSUNTX05BTUVTUEFDRTogJ1NDQScsXG4gICAgICAgIExPR19MRVZFTDogJ0lORk8nLFxuICAgICAgfSxcbiAgICAgIHRyYWNpbmc6IGxhbWJkYS5UcmFjaW5nLkFDVElWRSxcbiAgICAgIGR1cmFibGVDb25maWc6IHtcbiAgICAgICAgZXhlY3V0aW9uVGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICAgIHJldGVudGlvblBlcmlvZDogY2RrLkR1cmF0aW9uLmRheXMoNyksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgZWxpZ2liaWxpdHlDaGVja2VyRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnZHluYW1vZGI6UHV0SXRlbScsICdkeW5hbW9kYjpVcGRhdGVJdGVtJ10sXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpkeW5hbW9kYjoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06dGFibGUvc2NhLWFuYWx5dGljc2BdLFxuICAgIH0pKTtcblxuICAgIGVsaWdpYmlsaXR5Q2hlY2tlckZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ2JlZHJvY2s6SW52b2tlTW9kZWwnXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuXG4gICAgZWxpZ2liaWxpdHlDaGVja2VyRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnZ2VvLXBsYWNlczpHZW9jb2RlJ10sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgIH0pKTtcblxuXG4gICAgZWxpZ2liaWxpdHlDaGVja2VyRnVuY3Rpb24uYWRkUGVybWlzc2lvbignQ29ubmVjdEludm9rZScsIHtcbiAgICAgIHByaW5jaXBhbDogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdjb25uZWN0LmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIHNvdXJjZUFybjogcHJvcHMuY29ubmVjdEluc3RhbmNlQXJuLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZWxpZ2liaWxpdHlDaGVja2VyQWxpYXMgPSBuZXcgbGFtYmRhLkFsaWFzKHRoaXMsICdFbGlnaWJpbGl0eUNoZWNrZXJBbGlhcycsIHtcbiAgICAgIGFsaWFzTmFtZTogJ2xpdmUnLFxuICAgICAgdmVyc2lvbjogZWxpZ2liaWxpdHlDaGVja2VyRnVuY3Rpb24ubGF0ZXN0VmVyc2lvbixcbiAgICB9KTtcblxuICAgIGVsaWdpYmlsaXR5Q2hlY2tlckFsaWFzLmFkZFBlcm1pc3Npb24oJ0Nvbm5lY3RJbnZva2VBbGlhcycsIHtcbiAgICAgIHByaW5jaXBhbDogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdjb25uZWN0LmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIHNvdXJjZUFybjogcHJvcHMuY29ubmVjdEluc3RhbmNlQXJuLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZWxpZ2liaWxpdHlDaGVja2VyQXJuID0gZWxpZ2liaWxpdHlDaGVja2VyQWxpYXMuZnVuY3Rpb25Bcm47XG5cbiAgICAvLyBVcGRhdGVTZXNzaW9uRGF0YSBMYW1iZGEg4oCUIHVwZGF0ZXMgV2lzZG9tIHNlc3Npb24gd2l0aCBwcmVmZXJyZWQgbGFuZ3VhZ2VcbiAgICBjb25zdCB1cGRhdGVTZXNzaW9uRGF0YUZ1bmN0aW9uID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnVXBkYXRlU2Vzc2lvbkRhdGFGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzEzLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXIuaGFuZGxlcicsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoJ2JhY2tlbmQvdXBkYXRlLXNlc3Npb24tZGF0YScpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgUE9XRVJUT09MU19TRVJWSUNFX05BTUU6ICd1cGRhdGUtc2Vzc2lvbi1kYXRhJyxcbiAgICAgICAgTE9HX0xFVkVMOiAnSU5GTycsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgdXBkYXRlU2Vzc2lvbkRhdGFGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWyd3aXNkb206VXBkYXRlU2Vzc2lvbkRhdGEnLCAncWNvbm5lY3Q6VXBkYXRlU2Vzc2lvbkRhdGEnXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBgYXJuOmF3czp3aXNkb206JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OnNlc3Npb24vJHthc3Npc3RhbnQuYXR0ckFzc2lzdGFudElkfS8qYCxcbiAgICAgIF0sXG4gICAgfSkpO1xuXG4gICAgdXBkYXRlU2Vzc2lvbkRhdGFGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWydjb25uZWN0OkRlc2NyaWJlQ29udGFjdCddLFxuICAgICAgcmVzb3VyY2VzOiBbYCR7cHJvcHMuY29ubmVjdEluc3RhbmNlQXJufS8qYF0sXG4gICAgfSkpO1xuXG4gICAgdXBkYXRlU2Vzc2lvbkRhdGFGdW5jdGlvbi5hZGRQZXJtaXNzaW9uKCdDb25uZWN0SW52b2tlJywge1xuICAgICAgcHJpbmNpcGFsOiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Nvbm5lY3QuYW1hem9uYXdzLmNvbScpLFxuICAgICAgc291cmNlQXJuOiBwcm9wcy5jb25uZWN0SW5zdGFuY2VBcm4sXG4gICAgfSk7XG5cbiAgICBjb25zdCB1cGRhdGVTZXNzaW9uTGFtYmRhQXNzb2NpYXRpb24gPSBuZXcgY29ubmVjdC5DZm5JbnRlZ3JhdGlvbkFzc29jaWF0aW9uKHRoaXMsICdVcGRhdGVTZXNzaW9uTGFtYmRhQXNzb2NpYXRpb24nLCB7XG4gICAgICBpbnN0YW5jZUlkOiBwcm9wcy5jb25uZWN0SW5zdGFuY2VBcm4sXG4gICAgICBpbnRlZ3JhdGlvblR5cGU6ICdMQU1CREFfRlVOQ1RJT04nLFxuICAgICAgaW50ZWdyYXRpb25Bcm46IHVwZGF0ZVNlc3Npb25EYXRhRnVuY3Rpb24uZnVuY3Rpb25Bcm4sXG4gICAgfSk7XG5cbiAgICBjb25zdCB1cGRhdGVTZXNzaW9uRGF0YUFybiA9IHVwZGF0ZVNlc3Npb25EYXRhRnVuY3Rpb24uZnVuY3Rpb25Bcm47XG5cbiAgICBjb25zdCBsYW1iZGFBc3NvY2lhdGlvbiA9IG5ldyBjb25uZWN0LkNmbkludGVncmF0aW9uQXNzb2NpYXRpb24odGhpcywgJ0VsaWdpYmlsaXR5TGFtYmRhQXNzb2NpYXRpb24nLCB7XG4gICAgICBpbnN0YW5jZUlkOiBwcm9wcy5jb25uZWN0SW5zdGFuY2VBcm4sXG4gICAgICBpbnRlZ3JhdGlvblR5cGU6ICdMQU1CREFfRlVOQ1RJT04nLFxuICAgICAgaW50ZWdyYXRpb25Bcm46IGVsaWdpYmlsaXR5Q2hlY2tlckFybixcbiAgICB9KTtcblxuICAgIC8vIExvYWQgY29udGFjdCBmbG93IGZyb20gZXh0ZXJuYWwgSlNPTiBjb25maWcgYW5kIHJlcGxhY2UgcGxhY2Vob2xkZXJzXG4gICAgY29uc3QgY29udGFjdEZsb3dDb250ZW50ID0gZnMucmVhZEZpbGVTeW5jKFxuICAgICAgcGF0aC5qb2luKF9fZGlybmFtZSwgJ2NvbnRhY3QtZmxvd3MnLCAnaW5ib3VuZC1zYWxlcy1mbG93Lmpzb24nKSwgJ3V0Zi04J1xuICAgIClcbiAgICAgIC5yZXBsYWNlKC9cXHtcXHtXSVNET01fQVNTSVNUQU5UX0FSTlxcfVxcfS9nLCB0aGlzLndpc2RvbUFzc2lzdGFudEFybilcbiAgICAgIC5yZXBsYWNlKC9cXHtcXHtXRUxDT01FX0FHRU5UX0FSTlxcfVxcfS9nLCB0aGlzLndlbGNvbWVBZ2VudFZlcnNpb25Bcm4pXG4gICAgICAucmVwbGFjZSgvXFx7XFx7SU5UQUtFX0FHRU5UX0FSTlxcfVxcfS9nLCB0aGlzLmludGFrZUFnZW50VmVyc2lvbkFybilcbiAgICAgIC5yZXBsYWNlKC9cXHtcXHtMRVhfQk9UX0FMSUFTX0FSTlxcfVxcfS9nLCB0aGlzLmxleEJvdEFsaWFzQXJuKVxuICAgICAgLnJlcGxhY2UoL1xce1xce0VMSUdJQklMSVRZX0NIRUNLRVJfQVJOXFx9XFx9L2csIGVsaWdpYmlsaXR5Q2hlY2tlckFybilcbiAgICAgIC5yZXBsYWNlKC9cXHtcXHtVUERBVEVfU0VTU0lPTl9EQVRBX0FSTlxcfVxcfS9nLCB1cGRhdGVTZXNzaW9uRGF0YUFybik7XG5cbiAgICBjb25zdCBjb250YWN0RmxvdyA9IG5ldyBjb25uZWN0LkNmbkNvbnRhY3RGbG93KHRoaXMsICdJbmJvdW5kQ29udGFjdEZsb3cnLCB7XG4gICAgICBpbnN0YW5jZUFybjogcHJvcHMuY29ubmVjdEluc3RhbmNlQXJuLFxuICAgICAgdHlwZTogJ0NPTlRBQ1RfRkxPVycsXG4gICAgICBjb250ZW50OiBjb250YWN0Rmxvd0NvbnRlbnQsXG4gICAgICBuYW1lOiAnU0NBLUluYm91bmQtU2FsZXMtRmxvdycsXG4gICAgICBkZXNjcmlwdGlvbjogJ0luYm91bmQgc2FsZXMgZmxvdyB3aXRoIEFJIGFnZW50cywgTGV4IGJvdCwgcmVjb3JkaW5nLCBhbmQgYW5hbHl0aWNzJyxcbiAgICB9KTtcblxuICAgIGNvbnRhY3RGbG93LmFkZERlcGVuZGVuY3kobGV4Qm90QXNzb2NpYXRpb24pO1xuXG4gICAgLy8gRXhwb3NlIHRoZSBjcmVhdGVkIGNvbnRhY3QgZmxvdyBJRCAodXNlZCBieSB0aGUgY2hhdC92b2ljZSBMYW1iZGFzIGJlbG93KS5cbiAgICB0aGlzLmNvbnRhY3RGbG93SWQgPSBjZGsuRm4uc2VsZWN0KDMsIGNkay5Gbi5zcGxpdCgnLycsIGNvbnRhY3RGbG93LmF0dHJDb250YWN0Rmxvd0FybikpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEluLWFwcCBDaGF0ICsgV2ViUlRDIFZvaWNlIExhbWJkYXNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gVGhlc2UgTGFtYmRhcyBsaXZlIGhlcmUgKGRvd25zdHJlYW0gb2YgQ29ubmVjdCkgc28gdGhleSBjYW4gdXNlIHRoZSBsb2NhbGx5XG4gICAgLy8gY3JlYXRlZCBjb250YWN0IGZsb3cgSUQgYW5kIHRoZSBDb25uZWN0IGluc3RhbmNlIElEIHdpdGggbm8gY2lyY3VsYXIgZGVwZW5kZW5jeS5cbiAgICAvLyBUaGUgYmFja2VuZCBBUEkgKFNjYUJhY2tlbmRTdGFjaykgaW52b2tlcyB0aGVtIHZpYSBBUEkgR2F0ZXdheSBTVEFHRSBWQVJJQUJMRVNcbiAgICAvLyB0aGF0IHJlZmVyZW5jZSB0aGVzZSBmdW5jdGlvbnMgYnkgbmFtZSwgc28gdGhlcmUgaXMgbm8gY3Jvc3Mtc3RhY2sgQVJOIGltcG9ydFxuICAgIC8vIGFuZCB0aGUgQVBJIGNhbiBiZSBlZGl0ZWQgd2l0aG91dCByZWRlcGxveWluZyB0aGlzIHN0YWNrLlxuICAgIGNvbnN0IHN0YXJ0Q2hhdEZ1bmN0aW9uTmFtZTogc3RyaW5nID1cbiAgICAgIHRoaXMubm9kZS50cnlHZXRDb250ZXh0KCdzdGFydENoYXRGdW5jdGlvbk5hbWUnKSA/PyAnc2NhLXN0YXJ0LWNoYXQtY29udGFjdCc7XG4gICAgY29uc3Qgc3RhcnRXZWJSdGNGdW5jdGlvbk5hbWU6IHN0cmluZyA9XG4gICAgICB0aGlzLm5vZGUudHJ5R2V0Q29udGV4dCgnc3RhcnRXZWJSdGNGdW5jdGlvbk5hbWUnKSA/PyAnc2NhLXN0YXJ0LXdlYnJ0Yy1jb250YWN0JztcblxuICAgIGNvbnN0IHBvd2VydG9vbHNMYXllciA9IGxhbWJkYS5MYXllclZlcnNpb24uZnJvbUxheWVyVmVyc2lvbkFybihcbiAgICAgIHRoaXMsXG4gICAgICAnUG93ZXJ0b29sc0xheWVyQ29ubmVjdENvbnRhY3RzJyxcbiAgICAgIGBhcm46YXdzOmxhbWJkYToke3RoaXMucmVnaW9ufTowMTcwMDA4MDE0NDY6bGF5ZXI6QVdTTGFtYmRhUG93ZXJ0b29sc1B5dGhvblYzLSR7Y29uZmlnLnBvd2VydG9vbHNMYXllci5weXRob25WZXJzaW9ufS14ODZfNjQ6JHtjb25maWcucG93ZXJ0b29sc0xheWVyLnZlcnNpb259YFxuICAgICk7XG5cbiAgICBjb25zdCBjb25uZWN0Q29udGFjdEVudiA9IHtcbiAgICAgIENPTk5FQ1RfSU5TVEFOQ0VfSUQ6IGNvbm5lY3RJbnN0YW5jZUlkLFxuICAgICAgQ09OVEFDVF9GTE9XX0lEOiB0aGlzLmNvbnRhY3RGbG93SWQsXG4gICAgICBQT1dFUlRPT0xTX01FVFJJQ1NfTkFNRVNQQUNFOiAnU0NBJyxcbiAgICAgIExPR19MRVZFTDogJ0lORk8nLFxuICAgIH07XG5cbiAgICAvLyBTb3VyY2UgQVJOIHVzZWQgdG8gc2NvcGUgdGhlIEFQSSBHYXRld2F5IGludm9rZSBwZXJtaXNzaW9uIChvcHRpb25hbDsgd2hlbiB0aGVcbiAgICAvLyBiYWNrZW5kIEFQSSBJRCBpcyBwcm92aWRlZCB3ZSBzY29wZSB0byBpdCwgb3RoZXJ3aXNlIGFsbG93IHRoZSBhcGlnYXRld2F5IHNlcnZpY2UpLlxuICAgIGNvbnN0IGFwaVNvdXJjZUFybiA9IHByb3BzLmRhdGFSZXRyaWV2YWxBcGlJZFxuICAgICAgPyBgYXJuOmF3czpleGVjdXRlLWFwaToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06JHtwcm9wcy5kYXRhUmV0cmlldmFsQXBpSWR9LyovKi8qYFxuICAgICAgOiB1bmRlZmluZWQ7XG5cbiAgICAvLyAtLS0gU3RhcnRDaGF0Q29udGFjdCBMYW1iZGEgKFBPU1QgL2NoYXQvc3RhcnQpIC0tLVxuICAgIGNvbnN0IHN0YXJ0Q2hhdENvbnRhY3RGdW5jdGlvbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ1N0YXJ0Q2hhdENvbnRhY3QnLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6IHN0YXJ0Q2hhdEZ1bmN0aW9uTmFtZSxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzEzLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXIubGFtYmRhX2hhbmRsZXInLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi8uLi9iYWNrZW5kL3N0YXJ0LWNoYXQtY29udGFjdCcpLCB7XG4gICAgICAgIGJ1bmRsaW5nOiB7XG4gICAgICAgICAgaW1hZ2U6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzEzLmJ1bmRsaW5nSW1hZ2UsXG4gICAgICAgICAgY29tbWFuZDogW1xuICAgICAgICAgICAgJ2Jhc2gnLCAnLWMnLFxuICAgICAgICAgICAgJ3BpcCBpbnN0YWxsIC1yIHJlcXVpcmVtZW50cy50eHQgLXQgL2Fzc2V0LW91dHB1dCAmJiBjcCAtYXUgLiAvYXNzZXQtb3V0cHV0JyxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBsYXllcnM6IFtwb3dlcnRvb2xzTGF5ZXJdLFxuICAgICAgZW52aXJvbm1lbnQ6IHsgLi4uY29ubmVjdENvbnRhY3RFbnYsIFBPV0VSVE9PTFNfU0VSVklDRV9OQU1FOiAnc3RhcnQtY2hhdC1jb250YWN0JyB9LFxuICAgICAgdHJhY2luZzogbGFtYmRhLlRyYWNpbmcuQUNUSVZFLFxuICAgIH0pO1xuXG4gICAgc3RhcnRDaGF0Q29udGFjdEZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ2Nvbm5lY3Q6U3RhcnRDaGF0Q29udGFjdCddLFxuICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgIHByb3BzLmNvbm5lY3RJbnN0YW5jZUFybixcbiAgICAgICAgYCR7cHJvcHMuY29ubmVjdEluc3RhbmNlQXJufS8qYCxcbiAgICAgIF0sXG4gICAgfSkpO1xuXG4gICAgLy8gQWxsb3cgQVBJIEdhdGV3YXkgKGJhY2tlbmQgc3RhZ2UtdmFyaWFibGUgaW50ZWdyYXRpb24pIHRvIGludm9rZSB0aGlzIGZ1bmN0aW9uLlxuICAgIHN0YXJ0Q2hhdENvbnRhY3RGdW5jdGlvbi5hZGRQZXJtaXNzaW9uKCdBbGxvd0FwaUdhdGV3YXlJbnZva2VDaGF0Jywge1xuICAgICAgcHJpbmNpcGFsOiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2FwaWdhdGV3YXkuYW1hem9uYXdzLmNvbScpLFxuICAgICAgYWN0aW9uOiAnbGFtYmRhOkludm9rZUZ1bmN0aW9uJyxcbiAgICAgIC4uLihhcGlTb3VyY2VBcm4gPyB7IHNvdXJjZUFybjogYXBpU291cmNlQXJuIH0gOiB7fSksXG4gICAgfSk7XG5cbiAgICAvLyAtLS0gU3RhcnRXZWJSVENDb250YWN0IExhbWJkYSAoUE9TVCAvY2FsbC9zdGFydCkgLS0tXG4gICAgY29uc3Qgc3RhcnRXZWJSdGNDb250YWN0RnVuY3Rpb24gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdTdGFydFdlYlJUQ0NvbnRhY3QnLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6IHN0YXJ0V2ViUnRjRnVuY3Rpb25OYW1lLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTMsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlci5sYW1iZGFfaGFuZGxlcicsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uLy4uL2JhY2tlbmQvc3RhcnQtd2VicnRjLWNvbnRhY3QnKSwge1xuICAgICAgICBidW5kbGluZzoge1xuICAgICAgICAgIGltYWdlOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMy5idW5kbGluZ0ltYWdlLFxuICAgICAgICAgIGNvbW1hbmQ6IFtcbiAgICAgICAgICAgICdiYXNoJywgJy1jJyxcbiAgICAgICAgICAgICdwaXAgaW5zdGFsbCAtciByZXF1aXJlbWVudHMudHh0IC10IC9hc3NldC1vdXRwdXQgJiYgY3AgLWF1IC4gL2Fzc2V0LW91dHB1dCcsXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgbGF5ZXJzOiBbcG93ZXJ0b29sc0xheWVyXSxcbiAgICAgIGVudmlyb25tZW50OiB7IC4uLmNvbm5lY3RDb250YWN0RW52LCBQT1dFUlRPT0xTX1NFUlZJQ0VfTkFNRTogJ3N0YXJ0LXdlYnJ0Yy1jb250YWN0JyB9LFxuICAgICAgdHJhY2luZzogbGFtYmRhLlRyYWNpbmcuQUNUSVZFLFxuICAgIH0pO1xuXG4gICAgc3RhcnRXZWJSdGNDb250YWN0RnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnY29ubmVjdDpTdGFydFdlYlJUQ0NvbnRhY3QnXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBwcm9wcy5jb25uZWN0SW5zdGFuY2VBcm4sXG4gICAgICAgIGAke3Byb3BzLmNvbm5lY3RJbnN0YW5jZUFybn0vKmAsXG4gICAgICBdLFxuICAgIH0pKTtcblxuICAgIHN0YXJ0V2ViUnRjQ29udGFjdEZ1bmN0aW9uLmFkZFBlcm1pc3Npb24oJ0FsbG93QXBpR2F0ZXdheUludm9rZUNhbGwnLCB7XG4gICAgICBwcmluY2lwYWw6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnYXBpZ2F0ZXdheS5hbWF6b25hd3MuY29tJyksXG4gICAgICBhY3Rpb246ICdsYW1iZGE6SW52b2tlRnVuY3Rpb24nLFxuICAgICAgLi4uKGFwaVNvdXJjZUFybiA/IHsgc291cmNlQXJuOiBhcGlTb3VyY2VBcm4gfSA6IHt9KSxcbiAgICB9KTtcblxuICAgIC8vIENESyBOYWcgc3VwcHJlc3Npb25zIGZvciB0aGUgdHdvIGNvbm5lY3QtY29udGFjdCBMYW1iZGFzXG4gICAgZm9yIChjb25zdCBmbklkIG9mIFsnU3RhcnRDaGF0Q29udGFjdCcsICdTdGFydFdlYlJUQ0NvbnRhY3QnXSkge1xuICAgICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zQnlQYXRoKFxuICAgICAgICB0aGlzLFxuICAgICAgICBgL1NjYUFpU3RhY2svJHtmbklkfS9TZXJ2aWNlUm9sZS9SZXNvdXJjZWAsXG4gICAgICAgIFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU00JyxcbiAgICAgICAgICAgIHJlYXNvbjogJ0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZSBpcyB0aGUgQVdTIHJlY29tbWVuZGVkIG1hbmFnZWQgcG9saWN5IGZvciBMYW1iZGEgZnVuY3Rpb25zLicsXG4gICAgICAgICAgICBhcHBsaWVzVG86IFsnUG9saWN5Ojphcm46PEFXUzo6UGFydGl0aW9uPjppYW06OmF3czpwb2xpY3kvc2VydmljZS1yb2xlL0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZSddLFxuICAgICAgICAgIH0sXG4gICAgICAgIF1cbiAgICAgICk7XG4gICAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnNCeVBhdGgoXG4gICAgICAgIHRoaXMsXG4gICAgICAgIGAvU2NhQWlTdGFjay8ke2ZuSWR9L1NlcnZpY2VSb2xlL0RlZmF1bHRQb2xpY3kvUmVzb3VyY2VgLFxuICAgICAgICBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgICAgICByZWFzb246ICdDb25uZWN0IFN0YXJ0Q2hhdENvbnRhY3QvU3RhcnRXZWJSVENDb250YWN0IHJlcXVpcmUgd2lsZGNhcmQgb24gaW5zdGFuY2Ugc3ViLXJlc291cmNlcyAnICtcbiAgICAgICAgICAgICAgICAgICAgJyhjb250YWN0LWZsb3cvKiwgY29udGFjdC8qKS4gWC1SYXkgdHJhY2luZyBhbHNvIHJlcXVpcmVzIFJlc291cmNlOjoqIGZvciBQdXRUcmFjZVNlZ21lbnRzIGFuZCBQdXRUZWxlbWV0cnlSZWNvcmRzLicsXG4gICAgICAgICAgICBhcHBsaWVzVG86IFtcbiAgICAgICAgICAgICAgeyByZWdleDogJy9eUmVzb3VyY2U6OmFybjphd3M6Y29ubmVjdDouKzpcXFxcZHsxMn06aW5zdGFuY2VcXFxcLy4rXFxcXC9cXFxcKiQvJyB9LFxuICAgICAgICAgICAgICAnUmVzb3VyY2U6OionLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9LFxuICAgICAgICBdXG4gICAgICApO1xuICAgICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zQnlQYXRoKFxuICAgICAgICB0aGlzLFxuICAgICAgICBgL1NjYUFpU3RhY2svJHtmbklkfS9SZXNvdXJjZWAsXG4gICAgICAgIFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1MMScsXG4gICAgICAgICAgICByZWFzb246ICdMYW1iZGEgZnVuY3Rpb24gaXMgdXNpbmcgUHl0aG9uIDMuMTMsIHdoaWNoIGlzIHRoZSBsYXRlc3QgYXZhaWxhYmxlIHJ1bnRpbWUgdmVyc2lvbi4nLFxuICAgICAgICAgIH0sXG4gICAgICAgIF1cbiAgICAgICk7XG4gICAgfVxuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1N0YXJ0Q2hhdENvbnRhY3RGdW5jdGlvbk5hbWUnLCB7XG4gICAgICB2YWx1ZTogc3RhcnRDaGF0Q29udGFjdEZ1bmN0aW9uLmZ1bmN0aW9uTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU3RhcnRDaGF0Q29udGFjdCBMYW1iZGEgZnVuY3Rpb24gbmFtZSAoYmFja2VuZCBzdGFnZSB2YXJpYWJsZSBzdGFydENoYXRGbiknLFxuICAgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdTdGFydFdlYlJUQ0NvbnRhY3RGdW5jdGlvbk5hbWUnLCB7XG4gICAgICB2YWx1ZTogc3RhcnRXZWJSdGNDb250YWN0RnVuY3Rpb24uZnVuY3Rpb25OYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdTdGFydFdlYlJUQ0NvbnRhY3QgTGFtYmRhIGZ1bmN0aW9uIG5hbWUgKGJhY2tlbmQgc3RhZ2UgdmFyaWFibGUgc3RhcnRXZWJSdGNGbiknLFxuICAgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDb250YWN0Rmxvd0lkJywge1xuICAgICAgdmFsdWU6IHRoaXMuY29udGFjdEZsb3dJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU0NBLUluYm91bmQtU2FsZXMtRmxvdyBjb250YWN0IGZsb3cgSUQnLFxuICAgIH0pO1xuXG4gICAgLy8gQXNzb2NpYXRlIHBob25lIG51bWJlciB3aXRoIGNvbnRhY3QgZmxvd1xuICAgIGNvbnN0IGFzc29jaWF0ZVBob25lTnVtYmVyRnVuY3Rpb24gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdBc3NvY2lhdGVQaG9uZU51bWJlckZ1bmN0aW9uJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTIsXG4gICAgICBoYW5kbGVyOiAnaW5kZXguaGFuZGxlcicsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygyKSxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21JbmxpbmUoYFxuaW1wb3J0IGpzb25cbmltcG9ydCBib3RvM1xuXG5jb25uZWN0ID0gYm90bzMuY2xpZW50KCdjb25uZWN0JylcblxuZGVmIGhhbmRsZXIoZXZlbnQsIGNvbnRleHQpOlxuICAgIHByaW50KGZcIkV2ZW50OiB7anNvbi5kdW1wcyhldmVudCl9XCIpXG4gICAgcmVxdWVzdF90eXBlID0gZXZlbnRbJ1JlcXVlc3RUeXBlJ11cbiAgICBpbnN0YW5jZV9pZCA9IGV2ZW50WydSZXNvdXJjZVByb3BlcnRpZXMnXVsnSW5zdGFuY2VJZCddXG4gICAgcGhvbmVfbnVtYmVyX2lkID0gZXZlbnRbJ1Jlc291cmNlUHJvcGVydGllcyddWydQaG9uZU51bWJlcklkJ11cbiAgICBjb250YWN0X2Zsb3dfaWQgPSBldmVudFsnUmVzb3VyY2VQcm9wZXJ0aWVzJ11bJ0NvbnRhY3RGbG93SWQnXVxuICAgIHBoeXNpY2FsX2lkID0gZidwaG9uZS1mbG93LWFzc29jaWF0aW9uLXtwaG9uZV9udW1iZXJfaWR9J1xuICAgIHRyeTpcbiAgICAgICAgaWYgcmVxdWVzdF90eXBlIGluICgnQ3JlYXRlJywgJ1VwZGF0ZScpOlxuICAgICAgICAgICAgcmVzcG9uc2UgPSBjb25uZWN0LmFzc29jaWF0ZV9waG9uZV9udW1iZXJfY29udGFjdF9mbG93KFxuICAgICAgICAgICAgICAgIFBob25lTnVtYmVySWQ9cGhvbmVfbnVtYmVyX2lkLCBJbnN0YW5jZUlkPWluc3RhbmNlX2lkLCBDb250YWN0Rmxvd0lkPWNvbnRhY3RfZmxvd19pZClcbiAgICAgICAgICAgIHJldHVybiB7J1BoeXNpY2FsUmVzb3VyY2VJZCc6IHBoeXNpY2FsX2lkLCAnRGF0YSc6IHsnU3RhdHVzJzogJ0Fzc29jaWF0ZWQnfX1cbiAgICAgICAgZWxpZiByZXF1ZXN0X3R5cGUgPT0gJ0RlbGV0ZSc6XG4gICAgICAgICAgICB0cnk6XG4gICAgICAgICAgICAgICAgY29ubmVjdC5kaXNhc3NvY2lhdGVfcGhvbmVfbnVtYmVyX2NvbnRhY3RfZmxvdyhQaG9uZU51bWJlcklkPXBob25lX251bWJlcl9pZCwgSW5zdGFuY2VJZD1pbnN0YW5jZV9pZClcbiAgICAgICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZTpcbiAgICAgICAgICAgICAgICBwcmludChmXCJFcnJvciBkdXJpbmcgY2xlYW51cDoge2V9XCIpXG4gICAgICAgICAgICByZXR1cm4geydQaHlzaWNhbFJlc291cmNlSWQnOiBwaHlzaWNhbF9pZCwgJ0RhdGEnOiB7J1N0YXR1cyc6ICdEaXNhc3NvY2lhdGVkJ319XG4gICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOlxuICAgICAgICBwcmludChmXCJFcnJvcjoge3N0cihlKX1cIilcbiAgICAgICAgcmFpc2VcbmApLFxuICAgIH0pO1xuXG4gICAgYXNzb2NpYXRlUGhvbmVOdW1iZXJGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWydjb25uZWN0OkFzc29jaWF0ZVBob25lTnVtYmVyQ29udGFjdEZsb3cnLCAnY29ubmVjdDpEaXNhc3NvY2lhdGVQaG9uZU51bWJlckNvbnRhY3RGbG93J10sXG4gICAgICByZXNvdXJjZXM6IFtwcm9wcy5waG9uZU51bWJlckFybiwgY29udGFjdEZsb3cuYXR0ckNvbnRhY3RGbG93QXJuXSxcbiAgICB9KSk7XG5cbiAgICBjb25zdCBhc3NvY2lhdGVQaG9uZU51bWJlclByb3ZpZGVyID0gbmV3IGNyLlByb3ZpZGVyKHRoaXMsICdBc3NvY2lhdGVQaG9uZU51bWJlclByb3ZpZGVyJywge1xuICAgICAgb25FdmVudEhhbmRsZXI6IGFzc29jaWF0ZVBob25lTnVtYmVyRnVuY3Rpb24sXG4gICAgfSk7XG5cbiAgICBjb25zdCBwaG9uZU51bWJlckFzc29jaWF0aW9uID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnUGhvbmVOdW1iZXJBc3NvY2lhdGlvbicsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogYXNzb2NpYXRlUGhvbmVOdW1iZXJQcm92aWRlci5zZXJ2aWNlVG9rZW4sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEluc3RhbmNlSWQ6IGNvbm5lY3RJbnN0YW5jZUlkLFxuICAgICAgICBQaG9uZU51bWJlcklkOiBjZGsuRm4uc2VsZWN0KDEsIGNkay5Gbi5zcGxpdCgncGhvbmUtbnVtYmVyLycsIHByb3BzLnBob25lTnVtYmVyQXJuKSksXG4gICAgICAgIENvbnRhY3RGbG93SWQ6IGNvbnRhY3RGbG93LmF0dHJDb250YWN0Rmxvd0Fybi5zcGxpdCgnLycpLnBvcCgpLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBwaG9uZU51bWJlckFzc29jaWF0aW9uLm5vZGUuYWRkRGVwZW5kZW5jeShjb250YWN0Rmxvdyk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT3V0cHV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdMZXhCb3RJZCcsIHsgdmFsdWU6IGJvdC5hdHRySWQsIGRlc2NyaXB0aW9uOiAnTGV4IFYyIEJvdCBJRCcgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xleEJvdEFsaWFzQXJuJywgeyB2YWx1ZTogdGhpcy5sZXhCb3RBbGlhc0FybiwgZGVzY3JpcHRpb246ICdMZXggVjIgQm90IEFsaWFzIEFSTicgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1dpc2RvbUFzc2lzdGFudEFybicsIHsgdmFsdWU6IHRoaXMud2lzZG9tQXNzaXN0YW50QXJuLCBkZXNjcmlwdGlvbjogJ0FtYXpvbiBRIGluIENvbm5lY3QgQXNzaXN0YW50IEFSTicgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1dlbGNvbWVBZ2VudEFybicsIHsgdmFsdWU6IHRoaXMud2VsY29tZUFnZW50VmVyc2lvbkFybiwgZGVzY3JpcHRpb246ICdXZWxjb21lIEFJIEFnZW50IEFSTicgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0luVGFrZUFnZW50QXJuJywgeyB2YWx1ZTogdGhpcy5pbnRha2VBZ2VudFZlcnNpb25Bcm4sIGRlc2NyaXB0aW9uOiAnSW5UYWtlIEFJIEFnZW50IEFSTicgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0NvbnRhY3RGbG93QXJuJywgeyB2YWx1ZTogY29udGFjdEZsb3cuYXR0ckNvbnRhY3RGbG93QXJuLCBkZXNjcmlwdGlvbjogJ0NvbnRhY3QgRmxvdyBBUk4nIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENESyBOYWcgU3VwcHJlc3Npb25zXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zQnlQYXRoKHRoaXMsIGAvJHtpZH0vTGV4Qm90Um9sZS9EZWZhdWx0UG9saWN5L1Jlc291cmNlYCwgW1xuICAgICAge1xuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JyxcbiAgICAgICAgcmVhc29uOiAnUG9sbHkgU3ludGhlc2l6ZVNwZWVjaCBhbmQgQ29tcHJlaGVuZCBEZXRlY3RTZW50aW1lbnQgcmVxdWlyZSB3aWxkY2FyZCByZXNvdXJjZS4gV2lzZG9tIHNlc3Npb24gcmVzb3VyY2VzIHVzZSB3aWxkY2FyZCBmb3IgZHluYW1pYyBzZXNzaW9uIElEcy4nLFxuICAgICAgfSxcbiAgICBdKTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9uc0J5UGF0aCh0aGlzLCBgLyR7aWR9L1dpc2RvbUNvbm5lY3RBc3NvY2lhdGlvbi9DdXN0b21SZXNvdXJjZVBvbGljeS9SZXNvdXJjZWAsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsIHJlYXNvbjogJ1dpbGRjYXJkIG5lZWRlZCBmb3IgQ29ubmVjdCBpbnRlZ3JhdGlvbiBhc3NvY2lhdGlvbiBzdWItcmVzb3VyY2VzLicgfSxcbiAgICBdKTtcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnNCeVBhdGgodGhpcywgYC8ke2lkfS9BV1M2NzlmNTNmYWMwMDI0MzBjYjBkYTViNzk4MmJkMjI4Ny9TZXJ2aWNlUm9sZS9SZXNvdXJjZWAsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNCcsIHJlYXNvbjogJ0FXUyBtYW5hZ2VkIHBvbGljeSByZXF1aXJlZCBmb3IgQXdzQ3VzdG9tUmVzb3VyY2UgTGFtYmRhLicsIGFwcGxpZXNUbzogWydQb2xpY3k6OmFybjo8QVdTOjpQYXJ0aXRpb24+OmlhbTo6YXdzOnBvbGljeS9zZXJ2aWNlLXJvbGUvQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlJ10gfSxcbiAgICBdKTtcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnNCeVBhdGgodGhpcywgYC8ke2lkfS9BV1M2NzlmNTNmYWMwMDI0MzBjYjBkYTViNzk4MmJkMjI4Ny9SZXNvdXJjZWAsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtTDEnLCByZWFzb246ICdMYW1iZGEgcnVudGltZSBtYW5hZ2VkIGJ5IENESyBBd3NDdXN0b21SZXNvdXJjZSBjb25zdHJ1Y3QuJyB9LFxuICAgIF0pO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFN0YWNrU3VwcHJlc3Npb25zKHRoaXMsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNCcsXG4gICAgICAgIHJlYXNvbjogJ0FXUyBtYW5hZ2VkIHBvbGljeSBBV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUgaXMgYXBwcm9wcmlhdGUgZm9yIExhbWJkYSBmdW5jdGlvbnMuJyxcbiAgICAgICAgYXBwbGllc1RvOiBbXG4gICAgICAgICAgJ1BvbGljeTo6YXJuOjxBV1M6OlBhcnRpdGlvbj46aWFtOjphd3M6cG9saWN5L3NlcnZpY2Utcm9sZS9BV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUnLFxuICAgICAgICAgICdQb2xpY3k6OmFybjo8QVdTOjpQYXJ0aXRpb24+OmlhbTo6YXdzOnBvbGljeS9zZXJ2aWNlLXJvbGUvQVdTTGFtYmRhQmFzaWNEdXJhYmxlRXhlY3V0aW9uUm9sZVBvbGljeScsXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIF0pO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFN0YWNrU3VwcHJlc3Npb25zKHRoaXMsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtTDEnLCByZWFzb246ICdDREsgY3VzdG9tIHJlc291cmNlIExhbWJkYXMgdXNlIHJ1bnRpbWVzIG1hbmFnZWQgYnkgdGhlIENESyBmcmFtZXdvcmsuJyB9LFxuICAgIF0pO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFN0YWNrU3VwcHJlc3Npb25zKHRoaXMsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBDREsgY3VzdG9tIHJlc291cmNlIExhbWJkYXMgYW5kIHByb3ZpZGVyIGZyYW1ld29yay4nLFxuICAgICAgICBhcHBsaWVzVG86IFtcbiAgICAgICAgICBgUmVzb3VyY2U6OjxBc3NvY2lhdGVQaG9uZU51bWJlckZ1bmN0aW9uJHthc3NvY2lhdGVQaG9uZU51bWJlckZ1bmN0aW9uLm5vZGUuYWRkcn0uQXJuPjoqYCxcbiAgICAgICAgICAnUmVzb3VyY2U6OjxBc3NvY2lhdGVQaG9uZU51bWJlckZ1bmN0aW9uQTM1RjUxNUIuQXJuPjoqJyxcbiAgICAgICAgICAnUmVzb3VyY2U6OionLFxuICAgICAgICAgIGBSZXNvdXJjZTo6PFdpc2RvbUFzc2lzdGFudC5Bc3Npc3RhbnRBcm4+LypgLFxuICAgICAgICAgIGBSZXNvdXJjZTo6PENvbm5lY3RJbnN0YW5jZS5Bcm4+LypgLFxuICAgICAgICAgIGBSZXNvdXJjZTo6YXJuOmF3czp3aXNkb206JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OnNlc3Npb24vPFdpc2RvbUFzc2lzdGFudC5Bc3Npc3RhbnRJZD4vKmAsXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIF0pO1xuICB9XG5cbn1cbiJdfQ==