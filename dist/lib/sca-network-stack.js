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
exports.ScaNetworkStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const cdk_nag_1 = require("cdk-nag");
/**
 * ScaNetworkStack - Network infrastructure for the SCA solution
 *
 * This stack contains:
 * - VPC with private isolated subnets
 * - VPC endpoints for AWS services (S3, ECR, CloudWatch Logs, API Gateway)
 *
 * Resources are exposed via public readonly properties for use by other stacks.
 * NO CloudFormation exports are used to avoid cross-stack dependencies.
 */
class ScaNetworkStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // VPC with only private subnets (no NAT Gateway, no public subnets)
        this.vpc = new ec2.Vpc(this, 'ScaVpc', {
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
        });
        // Lock logical ID to prevent breaking changes
        this.vpc.node.defaultChild.overrideLogicalId('ScaVpcF197898D');
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
        // API Gateway VPC Endpoint (for private API access)
        this.apiGatewayVpcEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ApiGatewayVpcEndpoint', {
            vpc: this.vpc,
            service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
            privateDnsEnabled: true,
            subnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
        });
        // ========================================
        // CloudFormation Outputs (NO EXPORTS)
        // ========================================
        new cdk.CfnOutput(this, 'VpcId', {
            value: this.vpc.vpcId,
            description: 'VPC ID for the SCA solution',
        });
        new cdk.CfnOutput(this, 'ApiGatewayVpcEndpointId', {
            value: this.apiGatewayVpcEndpoint.vpcEndpointId,
            description: 'VPC Endpoint ID for API Gateway',
        });
        // ========================================
        // CDK Nag Suppressions
        // ========================================
        // Suppress VPC Flow Logs requirement
        // Flow logs add operational overhead and cost for a development/demo solution
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaNetworkStack/ScaVpc/Resource', [
            {
                id: 'AwsSolutions-VPC7',
                reason: 'VPC Flow Logs are not enabled to reduce operational overhead and costs for this solution. ' +
                    'For production deployments, enable Flow Logs for network troubleshooting and security analysis.',
            },
        ]);
        // Suppress VPC Endpoint security group validation failures
        // These are technical limitations with CDK Nag when using intrinsic functions
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, [
            '/ScaNetworkStack/EcrApiVpcEndpoint/SecurityGroup/Resource',
            '/ScaNetworkStack/EcrDkrVpcEndpoint/SecurityGroup/Resource',
            '/ScaNetworkStack/CloudWatchLogsVpcEndpoint/SecurityGroup/Resource',
            '/ScaNetworkStack/ApiGatewayVpcEndpoint/SecurityGroup/Resource',
        ], [
            {
                id: 'CdkNagValidationFailure',
                reason: 'Security group rules reference VPC CIDR block using Fn::GetAtt intrinsic function. ' +
                    'CDK Nag cannot validate rules with intrinsic functions at synthesis time. ' +
                    'The security groups correctly restrict access to VPC CIDR range.',
            },
        ]);
    }
}
exports.ScaNetworkStack = ScaNetworkStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NhLW5ldHdvcmstc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9pbmZyYXN0cnVjdHVyZS9saWIvc2NhLW5ldHdvcmstc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLHlEQUEyQztBQUUzQyxxQ0FBMEM7QUFFMUM7Ozs7Ozs7OztHQVNHO0FBQ0gsTUFBYSxlQUFnQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBSTVDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBc0I7UUFDOUQsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsb0VBQW9FO1FBQ3BFLElBQUksQ0FBQyxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUU7WUFDckMsTUFBTSxFQUFFLENBQUM7WUFDVCxXQUFXLEVBQUUsQ0FBQztZQUNkLG1CQUFtQixFQUFFO2dCQUNuQjtvQkFDRSxRQUFRLEVBQUUsRUFBRTtvQkFDWixJQUFJLEVBQUUsU0FBUztvQkFDZixVQUFVLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxnQkFBZ0I7aUJBQzVDO2FBQ0Y7U0FDRixDQUFDLENBQUM7UUFFSCw4Q0FBOEM7UUFDN0MsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsWUFBMkIsQ0FBQyxpQkFBaUIsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO1FBRS9FLDJDQUEyQztRQUMzQyx5Q0FBeUM7UUFDekMsMkNBQTJDO1FBRTNDLGdFQUFnRTtRQUNoRSxJQUFJLENBQUMsR0FBRyxDQUFDLGtCQUFrQixDQUFDLG1CQUFtQixFQUFFO1lBQy9DLE9BQU8sRUFBRSxHQUFHLENBQUMsNEJBQTRCLENBQUMsRUFBRTtZQUM1QyxPQUFPLEVBQUU7Z0JBQ1A7b0JBQ0UsVUFBVSxFQUFFLEdBQUcsQ0FB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SUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBOYWdTdXBwcmVzc2lvbnMgfSBmcm9tICdjZGstbmFnJztcblxuLyoqXG4gKiBTY2FOZXR3b3JrU3RhY2sgLSBOZXR3b3JrIGluZnJhc3RydWN0dXJlIGZvciB0aGUgU0NBIHNvbHV0aW9uXG4gKiBcbiAqIFRoaXMgc3RhY2sgY29udGFpbnM6XG4gKiAtIFZQQyB3aXRoIHByaXZhdGUgaXNvbGF0ZWQgc3VibmV0c1xuICogLSBWUEMgZW5kcG9pbnRzIGZvciBBV1Mgc2VydmljZXMgKFMzLCBFQ1IsIENsb3VkV2F0Y2ggTG9ncywgQVBJIEdhdGV3YXkpXG4gKiBcbiAqIFJlc291cmNlcyBhcmUgZXhwb3NlZCB2aWEgcHVibGljIHJlYWRvbmx5IHByb3BlcnRpZXMgZm9yIHVzZSBieSBvdGhlciBzdGFja3MuXG4gKiBOTyBDbG91ZEZvcm1hdGlvbiBleHBvcnRzIGFyZSB1c2VkIHRvIGF2b2lkIGNyb3NzLXN0YWNrIGRlcGVuZGVuY2llcy5cbiAqL1xuZXhwb3J0IGNsYXNzIFNjYU5ldHdvcmtTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSB2cGM6IGVjMi5WcGM7XG4gIHB1YmxpYyByZWFkb25seSBhcGlHYXRld2F5VnBjRW5kcG9pbnQ6IGVjMi5JbnRlcmZhY2VWcGNFbmRwb2ludDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyBWUEMgd2l0aCBvbmx5IHByaXZhdGUgc3VibmV0cyAobm8gTkFUIEdhdGV3YXksIG5vIHB1YmxpYyBzdWJuZXRzKVxuICAgIHRoaXMudnBjID0gbmV3IGVjMi5WcGModGhpcywgJ1NjYVZwYycsIHtcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAwLFxuICAgICAgc3VibmV0Q29uZmlndXJhdGlvbjogW1xuICAgICAgICB7XG4gICAgICAgICAgY2lkck1hc2s6IDI0LFxuICAgICAgICAgIG5hbWU6ICdQcml2YXRlJyxcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX0lTT0xBVEVELFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcbiAgICBcbiAgICAvLyBMb2NrIGxvZ2ljYWwgSUQgdG8gcHJldmVudCBicmVha2luZyBjaGFuZ2VzXG4gICAgKHRoaXMudnBjLm5vZGUuZGVmYXVsdENoaWxkIGFzIGVjMi5DZm5WUEMpLm92ZXJyaWRlTG9naWNhbElkKCdTY2FWcGNGMTk3ODk4RCcpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFZQQyBFbmRwb2ludHMgZm9yIFByaXZhdGUgQ29ubmVjdGl2aXR5XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIFxuICAgIC8vIFMzIEdhdGV3YXkgRW5kcG9pbnQgKGZvciBFQ1IgaW1hZ2UgbGF5ZXJzIC0gbm8gaG91cmx5IGNoYXJnZSlcbiAgICB0aGlzLnZwYy5hZGRHYXRld2F5RW5kcG9pbnQoJ1MzR2F0ZXdheUVuZHBvaW50Jywge1xuICAgICAgc2VydmljZTogZWMyLkdhdGV3YXlWcGNFbmRwb2ludEF3c1NlcnZpY2UuUzMsXG4gICAgICBzdWJuZXRzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX0lTT0xBVEVELFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIC8vIEVDUiBBUEkgRW5kcG9pbnQgKGZvciBFQ1MgdG8gYXV0aGVudGljYXRlIGFuZCBnZXQgaW1hZ2UgbWFuaWZlc3RzKVxuICAgIG5ldyBlYzIuSW50ZXJmYWNlVnBjRW5kcG9pbnQodGhpcywgJ0VjckFwaVZwY0VuZHBvaW50Jywge1xuICAgICAgdnBjOiB0aGlzLnZwYyxcbiAgICAgIHNlcnZpY2U6IGVjMi5JbnRlcmZhY2VWcGNFbmRwb2ludEF3c1NlcnZpY2UuRUNSLFxuICAgICAgcHJpdmF0ZURuc0VuYWJsZWQ6IHRydWUsXG4gICAgICBzdWJuZXRzOiB7XG4gICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gRUNSIERvY2tlciBFbmRwb2ludCAoZm9yIEVDUyB0byBwdWxsIERvY2tlciBpbWFnZXMpXG4gICAgbmV3IGVjMi5JbnRlcmZhY2VWcGNFbmRwb2ludCh0aGlzLCAnRWNyRGtyVnBjRW5kcG9pbnQnLCB7XG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgc2VydmljZTogZWMyLkludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5FQ1JfRE9DS0VSLFxuICAgICAgcHJpdmF0ZURuc0VuYWJsZWQ6IHRydWUsXG4gICAgICBzdWJuZXRzOiB7XG4gICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQ2xvdWRXYXRjaCBMb2dzIEVuZHBvaW50IChmb3IgRUNTIGNvbnRhaW5lciBsb2dnaW5nKVxuICAgIG5ldyBlYzIuSW50ZXJmYWNlVnBjRW5kcG9pbnQodGhpcywgJ0Nsb3VkV2F0Y2hMb2dzVnBjRW5kcG9pbnQnLCB7XG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgc2VydmljZTogZWMyLkludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5DTE9VRFdBVENIX0xPR1MsXG4gICAgICBwcml2YXRlRG5zRW5hYmxlZDogdHJ1ZSxcbiAgICAgIHN1Ym5ldHM6IHtcbiAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9JU09MQVRFRCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBBUEkgR2F0ZXdheSBWUEMgRW5kcG9pbnQgKGZvciBwcml2YXRlIEFQSSBhY2Nlc3MpXG4gICAgdGhpcy5hcGlHYXRld2F5VnBjRW5kcG9pbnQgPSBuZXcgZWMyLkludGVyZmFjZVZwY0VuZHBvaW50KHRoaXMsICdBcGlHYXRld2F5VnBjRW5kcG9pbnQnLCB7XG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgc2VydmljZTogZWMyLkludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5BUElHQVRFV0FZLFxuICAgICAgcHJpdmF0ZURuc0VuYWJsZWQ6IHRydWUsXG4gICAgICBzdWJuZXRzOiB7XG4gICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENsb3VkRm9ybWF0aW9uIE91dHB1dHMgKE5PIEVYUE9SVFMpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIFxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdWcGNJZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnZwYy52cGNJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVlBDIElEIGZvciB0aGUgU0NBIHNvbHV0aW9uJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBcGlHYXRld2F5VnBjRW5kcG9pbnRJZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmFwaUdhdGV3YXlWcGNFbmRwb2ludC52cGNFbmRwb2ludElkLFxuICAgICAgZGVzY3JpcHRpb246ICdWUEMgRW5kcG9pbnQgSUQgZm9yIEFQSSBHYXRld2F5JyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDREsgTmFnIFN1cHByZXNzaW9uc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIFN1cHByZXNzIFZQQyBGbG93IExvZ3MgcmVxdWlyZW1lbnRcbiAgICAvLyBGbG93IGxvZ3MgYWRkIG9wZXJhdGlvbmFsIG92ZXJoZWFkIGFuZCBjb3N0IGZvciBhIGRldmVsb3BtZW50L2RlbW8gc29sdXRpb25cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnNCeVBhdGgoXG4gICAgICB0aGlzLFxuICAgICAgJy9TY2FOZXR3b3JrU3RhY2svU2NhVnBjL1Jlc291cmNlJyxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiAnQXdzU29sdXRpb25zLVZQQzcnLFxuICAgICAgICAgIHJlYXNvbjogJ1ZQQyBGbG93IExvZ3MgYXJlIG5vdCBlbmFibGVkIHRvIHJlZHVjZSBvcGVyYXRpb25hbCBvdmVyaGVhZCBhbmQgY29zdHMgZm9yIHRoaXMgc29sdXRpb24uICcgK1xuICAgICAgICAgICAgICAgICAgJ0ZvciBwcm9kdWN0aW9uIGRlcGxveW1lbnRzLCBlbmFibGUgRmxvdyBMb2dzIGZvciBuZXR3b3JrIHRyb3VibGVzaG9vdGluZyBhbmQgc2VjdXJpdHkgYW5hbHlzaXMuJyxcbiAgICAgICAgfSxcbiAgICAgIF1cbiAgICApO1xuXG4gICAgLy8gU3VwcHJlc3MgVlBDIEVuZHBvaW50IHNlY3VyaXR5IGdyb3VwIHZhbGlkYXRpb24gZmFpbHVyZXNcbiAgICAvLyBUaGVzZSBhcmUgdGVjaG5pY2FsIGxpbWl0YXRpb25zIHdpdGggQ0RLIE5hZyB3aGVuIHVzaW5nIGludHJpbnNpYyBmdW5jdGlvbnNcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnNCeVBhdGgoXG4gICAgICB0aGlzLFxuICAgICAgW1xuICAgICAgICAnL1NjYU5ldHdvcmtTdGFjay9FY3JBcGlWcGNFbmRwb2ludC9TZWN1cml0eUdyb3VwL1Jlc291cmNlJyxcbiAgICAgICAgJy9TY2FOZXR3b3JrU3RhY2svRWNyRGtyVnBjRW5kcG9pbnQvU2VjdXJpdHlHcm91cC9SZXNvdXJjZScsXG4gICAgICAgICcvU2NhTmV0d29ya1N0YWNrL0Nsb3VkV2F0Y2hMb2dzVnBjRW5kcG9pbnQvU2VjdXJpdHlHcm91cC9SZXNvdXJjZScsXG4gICAgICAgICcvU2NhTmV0d29ya1N0YWNrL0FwaUdhdGV3YXlWcGNFbmRwb2ludC9TZWN1cml0eUdyb3VwL1Jlc291cmNlJyxcbiAgICAgIF0sXG4gICAgICBbXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogJ0Nka05hZ1ZhbGlkYXRpb25GYWlsdXJlJyxcbiAgICAgICAgICByZWFzb246ICdTZWN1cml0eSBncm91cCBydWxlcyByZWZlcmVuY2UgVlBDIENJRFIgYmxvY2sgdXNpbmcgRm46OkdldEF0dCBpbnRyaW5zaWMgZnVuY3Rpb24uICcgK1xuICAgICAgICAgICAgICAgICAgJ0NESyBOYWcgY2Fubm90IHZhbGlkYXRlIHJ1bGVzIHdpdGggaW50cmluc2ljIGZ1bmN0aW9ucyBhdCBzeW50aGVzaXMgdGltZS4gJyArXG4gICAgICAgICAgICAgICAgICAnVGhlIHNlY3VyaXR5IGdyb3VwcyBjb3JyZWN0bHkgcmVzdHJpY3QgYWNjZXNzIHRvIFZQQyBDSURSIHJhbmdlLicsXG4gICAgICAgIH0sXG4gICAgICBdXG4gICAgKTtcbiAgfVxufVxuIl19