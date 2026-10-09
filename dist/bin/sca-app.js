#!/usr/bin/env node
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
require("source-map-support/register");
const cdk = __importStar(require("aws-cdk-lib"));
const cdk_nag_1 = require("cdk-nag");
const sca_network_stack_1 = require("../lib/sca-network-stack");
const sca_backend_stack_1 = require("../lib/sca-backend-stack");
const sca_ecr_stack_1 = require("../lib/sca-ecr-stack");
const sca_webapp_stack_1 = require("../lib/sca-webapp-stack");
const sca_cloudfront_access_stack_1 = require("../lib/sca-cloudfront-access-stack");
const sca_connect_stack_1 = require("../lib/sca-connect-stack");
const sca_ai_stack_1 = require("../lib/sca-ai-stack");
const app = new cdk.App();
// Add CDK Nag checks for AWS Solutions best practices
cdk.Aspects.of(app).add(new cdk_nag_1.AwsSolutionsChecks({ verbose: true }));
const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
};
// 1. Network Stack - VPC, subnets, VPC endpoints (foundation)
const networkStack = new sca_network_stack_1.ScaNetworkStack(app, 'ScaNetworkStack', { env });
// 2. Backend Stack - Kinesis, Lambda, DynamoDB, API Gateway, Cognito
const backendStack = new sca_backend_stack_1.ScaBackendStack(app, 'ScaBackendStack', {
    vpc: networkStack.vpc,
    apiGatewayVpcEndpoint: networkStack.apiGatewayVpcEndpoint,
    env,
});
backendStack.addDependency(networkStack);
// 3. ECR Stack - Container registry for web application
const ecrStack = new sca_ecr_stack_1.ScaEcrStack(app, 'ScaEcrStack', { env });
// 4. Web App Stack - ECS, ALB (requires ECR image to be pushed first)
const webAppStack = new sca_webapp_stack_1.ScaWebAppStack(app, 'ScaWebAppStack', {
    vpc: networkStack.vpc,
    cognitoUserPool: backendStack.cognitoUserPool,
    cognitoUserPoolClient: backendStack.cognitoUserPoolClient,
    dataRetrievalApi: backendStack.dataRetrievalApi,
    apiGatewayVpcEndpoint: networkStack.apiGatewayVpcEndpoint,
    ecrRepository: ecrStack.ecrRepository,
    env,
});
webAppStack.addDependency(networkStack);
webAppStack.addDependency(backendStack);
webAppStack.addDependency(ecrStack);
// Optional: CloudFront Access Stack (CloudFront, NAT Gateway, public subnets)
// Only deployed when explicitly enabled to prevent accidental public exposure
// Enable via context: cdk deploy ScaCloudFrontAccessStack -c enableCloudFrontAccess=true
const enableCloudFrontAccess = app.node.tryGetContext('enableCloudFrontAccess') === 'true';
if (enableCloudFrontAccess) {
    const cloudFrontAccessStack = new sca_cloudfront_access_stack_1.ScaCloudFrontAccessStack(app, 'ScaCloudFrontAccessStack', {
        vpc: networkStack.vpc,
        alb: webAppStack.alb,
        env,
    });
    cloudFrontAccessStack.addDependency(networkStack);
    cloudFrontAccessStack.addDependency(webAppStack);
}
// Optional: Connect + AI Integration Stacks
// Deploy with: cdk deploy ScaConnectStack ScaAiStack -c enableConnect=true
// ScaConnectStack creates the Connect instance and phone number.
// ScaAiStack creates the Lex bot, Wisdom assistant, orchestration AI agents,
// contact flow, and associates the phone number — no circular dependency.
const enableConnect = app.node.tryGetContext('enableConnect');
if (enableConnect === 'true') {
    // Connect Stack — instance, phone number, admin user, Contact Lens config
    const connectStack = new sca_connect_stack_1.ScaConnectStack(app, 'ScaConnectStack', {
        transcriptionStreamName: 'sca-transcription-stream',
        env,
    });
    connectStack.addDependency(backendStack);
    // AI Stack — Lex bot, Wisdom assistant, orchestration AI agents, contact flow, phone number association
    const aiStack = new sca_ai_stack_1.ScaAiStack(app, 'ScaAiStack', {
        connectInstanceArn: connectStack.connectInstance.attrArn,
        phoneNumberArn: connectStack.phoneNumber.attrPhoneNumberArn,
        // Scope the API Gateway invoke permission for the chat/voice Lambdas to the
        // backend data-retrieval API (which calls them via stage-variable integration).
        dataRetrievalApiId: backendStack.dataRetrievalApi.restApiId,
        env,
    });
    aiStack.addDependency(connectStack);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NhLWFwcC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2luZnJhc3RydWN0dXJlL2Jpbi9zY2EtYXBwLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUNBLHVDQUFxQztBQUNyQyxpREFBbUM7QUFDbkMscUNBQTZDO0FBQzdDLGdFQUEyRDtBQUMzRCxnRUFBMkQ7QUFDM0Qsd0RBQW1EO0FBQ25ELDhEQUF5RDtBQUN6RCxvRkFBOEU7QUFDOUUsZ0VBQTJEO0FBQzNELHNEQUFpRDtBQUVqRCxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztBQUUxQixzREFBc0Q7QUFDdEQsR0FBRyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksNEJBQWtCLENBQUMsRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBRW5FLE1BQU0sR0FBRyxHQUFHO0lBQ1YsT0FBTyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CO0lBQ3hDLE1BQU0sRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLGtCQUFrQjtDQUN2QyxDQUFDO0FBRUYsOERBQThEO0FBQzlELE1BQU0sWUFBWSxHQUFHLElBQUksbUNBQWUsQ0FBQyxHQUFHLEVBQUUsaUJBQWlCLEVBQUUsRUFBRSxHQUFHLEVBQUUsQ0FBQyxDQUFDO0FBRTFFLHFFQUFxRTtBQUNyRSxNQUFNLFlBQVksR0FBRyxJQUFJLG1DQUFlLENBQUMsR0FBRyxFQUFFLGlCQUFpQixFQUFFO0lBQy9ELEdBQUcsRUFBRSxZQUFZLENBQUMsR0FBRztJQUNyQixxQkFBcUIsRUFBRSxZQUFZLENBQUMscUJBQXFCO0lBQ3pELEdBQUc7Q0FDSixDQUFDLENBQUM7QUFDSCxZQUFZLENBQUMsYUFBYSxDQUFDLFlBQVksQ0FBQyxDQUFDO0FBRXpDLHdEQUF3RDtBQUN4RCxNQUFNLFFBQVEsR0FBRyxJQUFJLDJCQUFXLENBQUMsR0FBRyxFQUFFLGFBQWEsRUFBRSxFQUFFLEdBQUcsRUFBRSxDQUFDLENBQUM7QUFFOUQsc0VBQXNFO0FBQ3RFLE1BQU0sV0FBVyxHQUFHLElBQUksaUNBQWMsQ0FBQyxHQUFHLEVBQUUsZ0JBQWdCLEVBQUU7SUFDNUQsR0FBRyxFQUFFLFlBQVksQ0FBQyxHQUFHO0lBQ3JCLGVBQWUsRUFBRSxZQUFZLENBQUMsZUFBZTtJQUM3QyxxQkFBcUIsRUFBRSxZQUFZLENBQUMscUJBQXFCO0lBQ3pELGdCQUFnQixFQUFFLFlBQVksQ0FBQyxnQkFBZ0I7SUFDL0MscUJBQXFCLEVBQUUsWUFBWSxDQUFDLHFCQUFxQjtJQUN6RCxhQUFhLEVBQUUsUUFBUSxDQUFDLGFBQWE7SUFDckMsR0FBRztDQUNKLENBQUMsQ0FBQztBQUNILFdBQVcsQ0FBQyxhQUFhLENBQUMsWUFBWSxDQUFDLENBQUM7QUFDeEMsV0FBVyxDQUFDLGFBQWEsQ0FBQyxZQUFZLENBQUMsQ0FBQztBQUN4QyxXQUFXLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0FBRXBDLDhFQUE4RTtBQUM5RSw4RUFBOEU7QUFDOUUseUZBQXlGO0FBQ3pGLE1BQU0sc0JBQXNCLEdBQUcsR0FBRyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsd0JBQXdCLENBQUMsS0FBSyxNQUFNLENBQUM7QUFDM0YsSUFBSSxzQkFBc0IsRUFBRSxDQUFDO0lBQzNCLE1BQU0scUJBQXFCLEdBQUcsSUFBSSxzREFBd0IsQ0FBQyxHQUFHLEVBQUUsMEJBQTBCLEVBQUU7UUFDMUYsR0FBRyxFQUFFLFlBQVksQ0FBQyxHQUFHO1FBQ3JCLEdBQUcsRUFBRSxXQUFXLENBQUMsR0FBRztRQUNwQixHQUFHO0tBQ0osQ0FBQyxDQUFDO0lBQ0gscUJBQXFCLENBQUMsYUFBYSxDQUFDLFlBQVksQ0FBQyxDQUFDO0lBQ2xELHFCQUFxQixDQUFDLGFBQWEsQ0FBQyxXQUFXLENBQUMsQ0FBQztBQUNuRCxDQUFDO0FBRUQsNENBQTRDO0FBQzVDLDJFQUEyRTtBQUMzRSxpRUFBaUU7QUFDakUsNkVBQTZFO0FBQzdFLDBFQUEwRTtBQUMxRSxNQUFNLGFBQWEsR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxlQUFlLENBQUMsQ0FBQztBQUM5RCxJQUFJLGFBQWEsS0FBSyxNQUFNLEVBQUUsQ0FBQztJQUM3QiwwRUFBMEU7SUFDMUUsTUFBTSxZQUFZLEdBQUcsSUFBSSxtQ0FBZSxDQUFDLEdBQUcsRUFBRSxpQkFBaUIsRUFBRTtRQUMvRCx1QkFBdUIsRUFBRSwwQkFBMEI7UUFDbkQsR0FBRztLQUNKLENBQUMsQ0FBQztJQUNILFlBQVksQ0FBQyxhQUFhLENBQUMsWUFBWSxDQUFDLENBQUM7SUFFekMsd0dBQXdHO0lBQ3hHLE1BQU0sT0FBTyxHQUFHLElBQUkseUJBQVUsQ0FBQyxHQUFHLEVBQUUsWUFBWSxFQUFFO1FBQ2hELGtCQUFrQixFQUFFLFlBQVksQ0FBQyxlQUFlLENBQUMsT0FBTztRQUN4RCxjQUFjLEVBQUUsWUFBWSxDQUFDLFdBQVcsQ0FBQyxrQkFBa0I7UUFDM0QsNEVBQTRFO1FBQzVFLGdGQUFnRjtRQUNoRixrQkFBa0IsRUFBRSxZQUFZLENBQUMsZ0JBQWdCLENBQUMsU0FBUztRQUMzRCxHQUFHO0tBQ0osQ0FBQyxDQUFDO0lBQ0gsT0FBTyxDQUFDLGFBQWEsQ0FBQyxZQUFZLENBQUMsQ0FBQztBQUN0QyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiIyEvdXNyL2Jpbi9lbnYgbm9kZVxuaW1wb3J0ICdzb3VyY2UtbWFwLXN1cHBvcnQvcmVnaXN0ZXInO1xuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IEF3c1NvbHV0aW9uc0NoZWNrcyB9IGZyb20gJ2Nkay1uYWcnO1xuaW1wb3J0IHsgU2NhTmV0d29ya1N0YWNrIH0gZnJvbSAnLi4vbGliL3NjYS1uZXR3b3JrLXN0YWNrJztcbmltcG9ydCB7IFNjYUJhY2tlbmRTdGFjayB9IGZyb20gJy4uL2xpYi9zY2EtYmFja2VuZC1zdGFjayc7XG5pbXBvcnQgeyBTY2FFY3JTdGFjayB9IGZyb20gJy4uL2xpYi9zY2EtZWNyLXN0YWNrJztcbmltcG9ydCB7IFNjYVdlYkFwcFN0YWNrIH0gZnJvbSAnLi4vbGliL3NjYS13ZWJhcHAtc3RhY2snO1xuaW1wb3J0IHsgU2NhQ2xvdWRGcm9udEFjY2Vzc1N0YWNrIH0gZnJvbSAnLi4vbGliL3NjYS1jbG91ZGZyb250LWFjY2Vzcy1zdGFjayc7XG5pbXBvcnQgeyBTY2FDb25uZWN0U3RhY2sgfSBmcm9tICcuLi9saWIvc2NhLWNvbm5lY3Qtc3RhY2snO1xuaW1wb3J0IHsgU2NhQWlTdGFjayB9IGZyb20gJy4uL2xpYi9zY2EtYWktc3RhY2snO1xuXG5jb25zdCBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuXG4vLyBBZGQgQ0RLIE5hZyBjaGVja3MgZm9yIEFXUyBTb2x1dGlvbnMgYmVzdCBwcmFjdGljZXNcbmNkay5Bc3BlY3RzLm9mKGFwcCkuYWRkKG5ldyBBd3NTb2x1dGlvbnNDaGVja3MoeyB2ZXJib3NlOiB0cnVlIH0pKTtcblxuY29uc3QgZW52ID0ge1xuICBhY2NvdW50OiBwcm9jZXNzLmVudi5DREtfREVGQVVMVF9BQ0NPVU5ULFxuICByZWdpb246IHByb2Nlc3MuZW52LkNES19ERUZBVUxUX1JFR0lPTixcbn07XG5cbi8vIDEuIE5ldHdvcmsgU3RhY2sgLSBWUEMsIHN1Ym5ldHMsIFZQQyBlbmRwb2ludHMgKGZvdW5kYXRpb24pXG5jb25zdCBuZXR3b3JrU3RhY2sgPSBuZXcgU2NhTmV0d29ya1N0YWNrKGFwcCwgJ1NjYU5ldHdvcmtTdGFjaycsIHsgZW52IH0pO1xuXG4vLyAyLiBCYWNrZW5kIFN0YWNrIC0gS2luZXNpcywgTGFtYmRhLCBEeW5hbW9EQiwgQVBJIEdhdGV3YXksIENvZ25pdG9cbmNvbnN0IGJhY2tlbmRTdGFjayA9IG5ldyBTY2FCYWNrZW5kU3RhY2soYXBwLCAnU2NhQmFja2VuZFN0YWNrJywge1xuICB2cGM6IG5ldHdvcmtTdGFjay52cGMsXG4gIGFwaUdhdGV3YXlWcGNFbmRwb2ludDogbmV0d29ya1N0YWNrLmFwaUdhdGV3YXlWcGNFbmRwb2ludCxcbiAgZW52LFxufSk7XG5iYWNrZW5kU3RhY2suYWRkRGVwZW5kZW5jeShuZXR3b3JrU3RhY2spO1xuXG4vLyAzLiBFQ1IgU3RhY2sgLSBDb250YWluZXIgcmVnaXN0cnkgZm9yIHdlYiBhcHBsaWNhdGlvblxuY29uc3QgZWNyU3RhY2sgPSBuZXcgU2NhRWNyU3RhY2soYXBwLCAnU2NhRWNyU3RhY2snLCB7IGVudiB9KTtcblxuLy8gNC4gV2ViIEFwcCBTdGFjayAtIEVDUywgQUxCIChyZXF1aXJlcyBFQ1IgaW1hZ2UgdG8gYmUgcHVzaGVkIGZpcnN0KVxuY29uc3Qgd2ViQXBwU3RhY2sgPSBuZXcgU2NhV2ViQXBwU3RhY2soYXBwLCAnU2NhV2ViQXBwU3RhY2snLCB7XG4gIHZwYzogbmV0d29ya1N0YWNrLnZwYyxcbiAgY29nbml0b1VzZXJQb29sOiBiYWNrZW5kU3RhY2suY29nbml0b1VzZXJQb29sLFxuICBjb2duaXRvVXNlclBvb2xDbGllbnQ6IGJhY2tlbmRTdGFjay5jb2duaXRvVXNlclBvb2xDbGllbnQsXG4gIGRhdGFSZXRyaWV2YWxBcGk6IGJhY2tlbmRTdGFjay5kYXRhUmV0cmlldmFsQXBpLFxuICBhcGlHYXRld2F5VnBjRW5kcG9pbnQ6IG5ldHdvcmtTdGFjay5hcGlHYXRld2F5VnBjRW5kcG9pbnQsXG4gIGVjclJlcG9zaXRvcnk6IGVjclN0YWNrLmVjclJlcG9zaXRvcnksXG4gIGVudixcbn0pO1xud2ViQXBwU3RhY2suYWRkRGVwZW5kZW5jeShuZXR3b3JrU3RhY2spO1xud2ViQXBwU3RhY2suYWRkRGVwZW5kZW5jeShiYWNrZW5kU3RhY2spO1xud2ViQXBwU3RhY2suYWRkRGVwZW5kZW5jeShlY3JTdGFjayk7XG5cbi8vIE9wdGlvbmFsOiBDbG91ZEZyb250IEFjY2VzcyBTdGFjayAoQ2xvdWRGcm9udCwgTkFUIEdhdGV3YXksIHB1YmxpYyBzdWJuZXRzKVxuLy8gT25seSBkZXBsb3llZCB3aGVuIGV4cGxpY2l0bHkgZW5hYmxlZCB0byBwcmV2ZW50IGFjY2lkZW50YWwgcHVibGljIGV4cG9zdXJlXG4vLyBFbmFibGUgdmlhIGNvbnRleHQ6IGNkayBkZXBsb3kgU2NhQ2xvdWRGcm9udEFjY2Vzc1N0YWNrIC1jIGVuYWJsZUNsb3VkRnJvbnRBY2Nlc3M9dHJ1ZVxuY29uc3QgZW5hYmxlQ2xvdWRGcm9udEFjY2VzcyA9IGFwcC5ub2RlLnRyeUdldENvbnRleHQoJ2VuYWJsZUNsb3VkRnJvbnRBY2Nlc3MnKSA9PT0gJ3RydWUnO1xuaWYgKGVuYWJsZUNsb3VkRnJvbnRBY2Nlc3MpIHtcbiAgY29uc3QgY2xvdWRGcm9udEFjY2Vzc1N0YWNrID0gbmV3IFNjYUNsb3VkRnJvbnRBY2Nlc3NTdGFjayhhcHAsICdTY2FDbG91ZEZyb250QWNjZXNzU3RhY2snLCB7XG4gICAgdnBjOiBuZXR3b3JrU3RhY2sudnBjLFxuICAgIGFsYjogd2ViQXBwU3RhY2suYWxiLFxuICAgIGVudixcbiAgfSk7XG4gIGNsb3VkRnJvbnRBY2Nlc3NTdGFjay5hZGREZXBlbmRlbmN5KG5ldHdvcmtTdGFjayk7XG4gIGNsb3VkRnJvbnRBY2Nlc3NTdGFjay5hZGREZXBlbmRlbmN5KHdlYkFwcFN0YWNrKTtcbn1cblxuLy8gT3B0aW9uYWw6IENvbm5lY3QgKyBBSSBJbnRlZ3JhdGlvbiBTdGFja3Ncbi8vIERlcGxveSB3aXRoOiBjZGsgZGVwbG95IFNjYUNvbm5lY3RTdGFjayBTY2FBaVN0YWNrIC1jIGVuYWJsZUNvbm5lY3Q9dHJ1ZVxuLy8gU2NhQ29ubmVjdFN0YWNrIGNyZWF0ZXMgdGhlIENvbm5lY3QgaW5zdGFuY2UgYW5kIHBob25lIG51bWJlci5cbi8vIFNjYUFpU3RhY2sgY3JlYXRlcyB0aGUgTGV4IGJvdCwgV2lzZG9tIGFzc2lzdGFudCwgb3JjaGVzdHJhdGlvbiBBSSBhZ2VudHMsXG4vLyBjb250YWN0IGZsb3csIGFuZCBhc3NvY2lhdGVzIHRoZSBwaG9uZSBudW1iZXIg4oCUIG5vIGNpcmN1bGFyIGRlcGVuZGVuY3kuXG5jb25zdCBlbmFibGVDb25uZWN0ID0gYXBwLm5vZGUudHJ5R2V0Q29udGV4dCgnZW5hYmxlQ29ubmVjdCcpO1xuaWYgKGVuYWJsZUNvbm5lY3QgPT09ICd0cnVlJykge1xuICAvLyBDb25uZWN0IFN0YWNrIOKAlCBpbnN0YW5jZSwgcGhvbmUgbnVtYmVyLCBhZG1pbiB1c2VyLCBDb250YWN0IExlbnMgY29uZmlnXG4gIGNvbnN0IGNvbm5lY3RTdGFjayA9IG5ldyBTY2FDb25uZWN0U3RhY2soYXBwLCAnU2NhQ29ubmVjdFN0YWNrJywge1xuICAgIHRyYW5zY3JpcHRpb25TdHJlYW1OYW1lOiAnc2NhLXRyYW5zY3JpcHRpb24tc3RyZWFtJyxcbiAgICBlbnYsXG4gIH0pO1xuICBjb25uZWN0U3RhY2suYWRkRGVwZW5kZW5jeShiYWNrZW5kU3RhY2spO1xuXG4gIC8vIEFJIFN0YWNrIOKAlCBMZXggYm90LCBXaXNkb20gYXNzaXN0YW50LCBvcmNoZXN0cmF0aW9uIEFJIGFnZW50cywgY29udGFjdCBmbG93LCBwaG9uZSBudW1iZXIgYXNzb2NpYXRpb25cbiAgY29uc3QgYWlTdGFjayA9IG5ldyBTY2FBaVN0YWNrKGFwcCwgJ1NjYUFpU3RhY2snLCB7XG4gICAgY29ubmVjdEluc3RhbmNlQXJuOiBjb25uZWN0U3RhY2suY29ubmVjdEluc3RhbmNlLmF0dHJBcm4sXG4gICAgcGhvbmVOdW1iZXJBcm46IGNvbm5lY3RTdGFjay5waG9uZU51bWJlci5hdHRyUGhvbmVOdW1iZXJBcm4sXG4gICAgLy8gU2NvcGUgdGhlIEFQSSBHYXRld2F5IGludm9rZSBwZXJtaXNzaW9uIGZvciB0aGUgY2hhdC92b2ljZSBMYW1iZGFzIHRvIHRoZVxuICAgIC8vIGJhY2tlbmQgZGF0YS1yZXRyaWV2YWwgQVBJICh3aGljaCBjYWxscyB0aGVtIHZpYSBzdGFnZS12YXJpYWJsZSBpbnRlZ3JhdGlvbikuXG4gICAgZGF0YVJldHJpZXZhbEFwaUlkOiBiYWNrZW5kU3RhY2suZGF0YVJldHJpZXZhbEFwaS5yZXN0QXBpSWQsXG4gICAgZW52LFxuICB9KTtcbiAgYWlTdGFjay5hZGREZXBlbmRlbmN5KGNvbm5lY3RTdGFjayk7XG59XG4iXX0=