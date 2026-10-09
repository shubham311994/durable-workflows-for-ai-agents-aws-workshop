import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
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
export declare class ScaAiStack extends cdk.Stack {
    readonly lexBotAliasArn: string;
    readonly wisdomAssistantArn: string;
    readonly welcomeAgentVersionArn: string;
    readonly intakeAgentVersionArn: string;
    readonly contactFlowId: string;
    constructor(scope: Construct, id: string, props: ScaAiStackProps);
}
