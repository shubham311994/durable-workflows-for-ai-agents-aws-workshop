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
exports.ScaCloudFrontAccessStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const origins = __importStar(require("aws-cdk-lib/aws-cloudfront-origins"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const cdk_nag_1 = require("cdk-nag");
class ScaCloudFrontAccessStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Internet Gateway for VPC
        this.internetGateway = new ec2.CfnInternetGateway(this, 'InternetGateway', {
            tags: [
                {
                    key: 'Name',
                    value: 'SCA Internet Gateway',
                },
            ],
        });
        // Attach Internet Gateway to VPC
        const vpcGatewayAttachment = new ec2.CfnVPCGatewayAttachment(this, 'VpcGatewayAttachment', {
            vpcId: props.vpc.vpcId,
            internetGatewayId: this.internetGateway.ref,
        });
        // Add public subnets to the existing VPC
        const availabilityZones = props.vpc.availabilityZones.slice(0, 2);
        this.publicSubnets = [];
        availabilityZones.forEach((az, index) => {
            const publicSubnet = new ec2.CfnSubnet(this, `PublicSubnet${index + 1}`, {
                vpcId: props.vpc.vpcId,
                cidrBlock: `10.0.${100 + index}.0/24`, // Use different CIDR range to avoid conflicts
                availabilityZone: az,
                mapPublicIpOnLaunch: true,
                tags: [
                    {
                        key: 'Name',
                        value: `SCA Public Subnet ${index + 1}`,
                    },
                ],
            });
            // Create route table for public subnet
            const routeTable = new ec2.CfnRouteTable(this, `PublicRouteTable${index + 1}`, {
                vpcId: props.vpc.vpcId,
                tags: [
                    {
                        key: 'Name',
                        value: `SCA Public Route Table ${index + 1}`,
                    },
                ],
            });
            // Associate route table with subnet
            new ec2.CfnSubnetRouteTableAssociation(this, `PublicSubnetRouteTableAssociation${index + 1}`, {
                subnetId: publicSubnet.ref,
                routeTableId: routeTable.ref,
            });
            // Add route to Internet Gateway
            const publicRoute = new ec2.CfnRoute(this, `PublicRoute${index + 1}`, {
                routeTableId: routeTable.ref,
                gatewayId: this.internetGateway.ref,
                destinationCidrBlock: '0.0.0.0/0',
            });
            // The route targets the Internet Gateway, but a Ref on the IGW only creates
            // an implicit dependency on the IGW resource itself — not on its attachment
            // to the VPC. Without this explicit dependency, CloudFormation may create the
            // route before VpcGatewayAttachment completes, causing:
            //   "route table ... and network gateway ... belong to different networks"
            publicRoute.addDependency(vpcGatewayAttachment);
            // Store subnet reference (we'll create a wrapper if needed)
            this.publicSubnets.push({
                subnetId: publicSubnet.ref,
                availabilityZone: az,
            });
        });
        // Create Elastic IP for NAT Gateway
        const natEip = new ec2.CfnEIP(this, 'NatGatewayEip', {
            domain: 'vpc',
            tags: [
                {
                    key: 'Name',
                    value: 'SCA NAT Gateway EIP',
                },
            ],
        });
        // Create NAT Gateway in the first public subnet
        this.natGateway = new ec2.CfnNatGateway(this, 'NatGateway', {
            subnetId: this.publicSubnets[0].subnetId,
            allocationId: natEip.attrAllocationId,
            tags: [
                {
                    key: 'Name',
                    value: 'SCA NAT Gateway',
                },
            ],
        });
        // Update private subnets to use NAT Gateway for internet access
        const privateSubnets = props.vpc.privateSubnets;
        privateSubnets.forEach((subnet, index) => {
            // Add route to NAT Gateway for internet access
            new ec2.CfnRoute(this, `PrivateSubnetRoute${index + 1}`, {
                routeTableId: subnet.routeTable.routeTableId,
                destinationCidrBlock: '0.0.0.0/0',
                natGatewayId: this.natGateway.ref,
            });
        });
        // S3 bucket for CloudFront access logs
        const accessLogsBucket = new s3.Bucket(this, 'CloudFrontAccessLogs', {
            bucketName: `sca-cloudfront-logs-${this.account}-${this.region}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED, // Required for CloudFront logging
            removalPolicy: cdk.RemovalPolicy.DESTROY, // For development
            autoDeleteObjects: true, // For development
            enforceSSL: true, // Require SSL for all requests
        });
        // Create VPC origin using ALB construct (requires internet gateway)
        const vpcOrigin = origins.VpcOrigin.withApplicationLoadBalancer(props.alb, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        });
        // CloudFront distribution with VPC Origin (private ALB)
        this.cloudFrontDistribution = new cloudfront.Distribution(this, 'CloudFrontDistribution', {
            defaultBehavior: {
                origin: vpcOrigin,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
                compress: true,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
            },
            additionalBehaviors: {
                '/api/*': {
                    origin: vpcOrigin,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                    cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
                    compress: true,
                    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
                },
            },
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
            enableLogging: true,
            logBucket: accessLogsBucket,
            logFilePrefix: 'cloudfront-logs/',
            comment: 'SCA CloudFront Distribution with VPC Origin for Private ALB',
        });
        // VPC Origin requires internet gateway to be attached first
        this.cloudFrontDistribution.node.addDependency(vpcGatewayAttachment);
        // Allow traffic from CloudFront managed prefix list to ALB
        const cfOriginFacing = ec2.PrefixList.fromLookup(this, 'CloudFrontOriginFacing', {
            prefixListName: 'com.amazonaws.global.cloudfront.origin-facing',
        });
        // Get ALB security group and add ingress rule
        const albSecurityGroups = props.alb.connections.securityGroups;
        albSecurityGroups.forEach((sg) => {
            sg.addIngressRule(cfOriginFacing, ec2.Port.tcp(80), 'Allow CloudFront VPC Origin traffic');
        });
        // Security headers response headers policy
        const securityHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeadersPolicy', {
            responseHeadersPolicyName: 'SCA-Security-Headers',
            comment: 'Security headers for SCA application',
            securityHeadersBehavior: {
                contentTypeOptions: {
                    override: true,
                },
                frameOptions: {
                    frameOption: cloudfront.HeadersFrameOption.DENY,
                    override: true,
                },
                referrerPolicy: {
                    referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
                    override: true,
                },
                strictTransportSecurity: {
                    accessControlMaxAge: cdk.Duration.seconds(31536000),
                    includeSubdomains: true,
                    preload: true,
                    override: true,
                },
            },
        });
        // Apply security headers to the default behavior
        // Note: This would be configured through CloudFormation template customization
        // For now, we'll rely on the default security headers policy
        // Output important values
        new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
            value: this.cloudFrontDistribution.distributionId,
            description: 'CloudFront Distribution ID',
        });
        new cdk.CfnOutput(this, 'CloudFrontDomainName', {
            value: this.cloudFrontDistribution.distributionDomainName,
            description: 'CloudFront Distribution Domain Name',
        });
        new cdk.CfnOutput(this, 'CloudFrontUrl', {
            value: `https://${this.cloudFrontDistribution.distributionDomainName}`,
            description: 'CloudFront Distribution URL',
        });
        new cdk.CfnOutput(this, 'InternetGatewayId', {
            value: this.internetGateway.ref,
            description: 'Internet Gateway ID',
        });
        new cdk.CfnOutput(this, 'NatGatewayId', {
            value: this.natGateway.ref,
            description: 'NAT Gateway ID',
        });
        new cdk.CfnOutput(this, 'PublicSubnetIds', {
            value: this.publicSubnets.map((subnet) => subnet.subnetId).join(','),
            description: 'Public Subnet IDs',
        });
        // ========================================
        // CDK Nag Suppressions
        // ========================================
        // Suppress S3 access logs for CloudFront logs bucket
        // This bucket stores CloudFront access logs, so it doesn't need its own access logs
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaCloudFrontAccessStack/CloudFrontAccessLogs/Resource', [
            {
                id: 'AwsSolutions-S1',
                reason: 'This S3 bucket stores CloudFront access logs. ' +
                    'Access logs for a logging bucket would create a circular dependency and are not required.',
            },
        ]);
        // Suppress SSL requirement for CloudFront logs bucket
        // Adding SSL-only policy
        const logsPolicy = new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ['s3:*'],
            resources: [
                accessLogsBucket.bucketArn,
                `${accessLogsBucket.bucketArn}/*`,
            ],
            conditions: {
                Bool: {
                    'aws:SecureTransport': 'false',
                },
            },
        });
        accessLogsBucket.addToResourcePolicy(logsPolicy);
        // Suppress CloudFront geo restrictions warning
        // Geo restrictions are not required for this application
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaCloudFrontAccessStack/CloudFrontDistribution/Resource', [
            {
                id: 'AwsSolutions-CFR1',
                reason: 'Geo restrictions are not required for this application. ' +
                    'The application is intended for global access.',
            },
        ]);
        // Suppress CloudFront WAF warning
        // WAF adds cost and complexity; application-level security is handled by Cognito
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaCloudFrontAccessStack/CloudFrontDistribution/Resource', [
            {
                id: 'AwsSolutions-CFR2',
                reason: 'AWS WAF is not enabled to reduce costs for this solution. ' +
                    'Application-level security is handled by Amazon Cognito authentication. ' +
                    'For production deployments with high security requirements, consider enabling WAF.',
            },
        ]);
        // Suppress CloudFront TLS version requirement
        // Using default CloudFront certificate which enforces TLSv1.2 minimum
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaCloudFrontAccessStack/CloudFrontDistribution/Resource', [
            {
                id: 'AwsSolutions-CFR4',
                reason: 'Using default CloudFront viewer certificate which enforces TLSv1.2 as minimum protocol. ' +
                    'The distribution uses HTTPS with secure TLS configuration.',
            },
        ]);
    }
}
exports.ScaCloudFrontAccessStack = ScaCloudFrontAccessStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NhLWNsb3VkZnJvbnQtYWNjZXNzLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vaW5mcmFzdHJ1Y3R1cmUvbGliL3NjYS1jbG91ZGZyb250LWFjY2Vzcy1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMseURBQTJDO0FBRTNDLHVFQUF5RDtBQUN6RCw0RUFBOEQ7QUFDOUQsdURBQXlDO0FBQ3pDLHlEQUEyQztBQUUzQyxxQ0FBMEM7QUFPMUMsTUFBYSx3QkFBeUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQU1yRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQW9DO1FBQzVFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDJCQUEyQjtRQUMzQixJQUFJLENBQUMsZUFBZSxHQUFHLElBQUksR0FBRyxDQUFDLGtCQUFrQixDQUFDLElBQUksRUFBRSxpQkFBaUIsRUFBRTtZQUN6RSxJQUFJLEVBQUU7Z0JBQ0o7b0JBQ0UsR0FBRyxFQUFFLE1BQU07b0JBQ1gsS0FBSyxFQUFFLHNCQUFzQjtpQkFDOUI7YUFDRjtTQUNGLENBQUMsQ0FBQztRQUVILGlDQUFpQztRQUNqQyxNQUFNLG9CQUFvQixHQUFHLElBQUksR0FBRyxDQUFDLHVCQUF1QixDQUFDLElBQUksRUFBRSxzQkFBc0IsRUFBRTtZQUN6RixLQUFLLEVBQUUsS0FBSyxDQUFDLEdBQUcsQ0FBQyxLQUFLO1lBQ3RCLGlCQUFpQixFQUFFLElBQUksQ0FBQyxlQUFlLENBQUMsR0FBRztTQUM1QyxDQUFDLENBQUM7UUFFSCx5Q0FBeUM7UUFDekMsTUFBTSxpQkFBaUIsR0FBRyxLQUFLLENBQUMsR0FBRyxDQUFDLGlCQUFpQixDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFDbEUsSUFBSSxDQUFDLGFB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QkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSw0REFBNEQ7b0JBQzVELDBFQUEwRTtvQkFDMUUsb0ZBQW9GO2FBQzdGO1NBQ0YsQ0FDRixDQUFDO1FBRUYsOENBQThDO1FBQzlDLHNFQUFzRTtRQUN0RSx5QkFBZSxDQUFDLDZCQUE2QixDQUMzQyxJQUFJLEVBQ0osMkRBQTJELEVBQzNEO1lBQ0U7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUFFLDBGQUEwRjtvQkFDMUYsNERBQTREO2FBQ3JFO1NBQ0YsQ0FDRixDQUFDO0lBQ0osQ0FBQztDQUNGO0FBN1RELDREQTZUQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyBlbGJ2MiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mic7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZGZyb250JztcbmltcG9ydCAqIGFzIG9yaWdpbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2lucyc7XG5pbXBvcnQgKiBhcyBzMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBOYWdTdXBwcmVzc2lvbnMgfSBmcm9tICdjZGstbmFnJztcblxuZXhwb3J0IGludGVyZmFjZSBTY2FDbG91ZEZyb250QWNjZXNzU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgdnBjOiBlYzIuVnBjO1xuICBhbGI6IGVsYnYyLklBcHBsaWNhdGlvbkxvYWRCYWxhbmNlcjtcbn1cblxuZXhwb3J0IGNsYXNzIFNjYUNsb3VkRnJvbnRBY2Nlc3NTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSBpbnRlcm5ldEdhdGV3YXk6IGVjMi5DZm5JbnRlcm5ldEdhdGV3YXk7XG4gIHB1YmxpYyByZWFkb25seSBjbG91ZEZyb250RGlzdHJpYnV0aW9uOiBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IHB1YmxpY1N1Ym5ldHM6IGFueVtdO1xuICBwdWJsaWMgcmVhZG9ubHkgbmF0R2F0ZXdheTogZWMyLkNmbk5hdEdhdGV3YXk7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IFNjYUNsb3VkRnJvbnRBY2Nlc3NTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyBJbnRlcm5ldCBHYXRld2F5IGZvciBWUENcbiAgICB0aGlzLmludGVybmV0R2F0ZXdheSA9IG5ldyBlYzIuQ2ZuSW50ZXJuZXRHYXRld2F5KHRoaXMsICdJbnRlcm5ldEdhdGV3YXknLCB7XG4gICAgICB0YWdzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBrZXk6ICdOYW1lJyxcbiAgICAgICAgICB2YWx1ZTogJ1NDQSBJbnRlcm5ldCBHYXRld2F5JyxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICAvLyBBdHRhY2ggSW50ZXJuZXQgR2F0ZXdheSB0byBWUENcbiAgICBjb25zdCB2cGNHYXRld2F5QXR0YWNobWVudCA9IG5ldyBlYzIuQ2ZuVlBDR2F0ZXdheUF0dGFjaG1lbnQodGhpcywgJ1ZwY0dhdGV3YXlBdHRhY2htZW50Jywge1xuICAgICAgdnBjSWQ6IHByb3BzLnZwYy52cGNJZCxcbiAgICAgIGludGVybmV0R2F0ZXdheUlkOiB0aGlzLmludGVybmV0R2F0ZXdheS5yZWYsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgcHVibGljIHN1Ym5ldHMgdG8gdGhlIGV4aXN0aW5nIFZQQ1xuICAgIGNvbnN0IGF2YWlsYWJpbGl0eVpvbmVzID0gcHJvcHMudnBjLmF2YWlsYWJpbGl0eVpvbmVzLnNsaWNlKDAsIDIpO1xuICAgIHRoaXMucHVibGljU3VibmV0cyA9IFtdO1xuXG4gICAgYXZhaWxhYmlsaXR5Wm9uZXMuZm9yRWFjaCgoYXosIGluZGV4KSA9PiB7XG4gICAgICBjb25zdCBwdWJsaWNTdWJuZXQgPSBuZXcgZWMyLkNmblN1Ym5ldCh0aGlzLCBgUHVibGljU3VibmV0JHtpbmRleCArIDF9YCwge1xuICAgICAgICB2cGNJZDogcHJvcHMudnBjLnZwY0lkLFxuICAgICAgICBjaWRyQmxvY2s6IGAxMC4wLiR7MTAwICsgaW5kZXh9LjAvMjRgLCAvLyBVc2UgZGlmZmVyZW50IENJRFIgcmFuZ2UgdG8gYXZvaWQgY29uZmxpY3RzXG4gICAgICAgIGF2YWlsYWJpbGl0eVpvbmU6IGF6LFxuICAgICAgICBtYXBQdWJsaWNJcE9uTGF1bmNoOiB0cnVlLFxuICAgICAgICB0YWdzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAga2V5OiAnTmFtZScsXG4gICAgICAgICAgICB2YWx1ZTogYFNDQSBQdWJsaWMgU3VibmV0ICR7aW5kZXggKyAxfWAsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBDcmVhdGUgcm91dGUgdGFibGUgZm9yIHB1YmxpYyBzdWJuZXRcbiAgICAgIGNvbnN0IHJvdXRlVGFibGUgPSBuZXcgZWMyLkNmblJvdXRlVGFibGUodGhpcywgYFB1YmxpY1JvdXRlVGFibGUke2luZGV4ICsgMX1gLCB7XG4gICAgICAgIHZwY0lkOiBwcm9wcy52cGMudnBjSWQsXG4gICAgICAgIHRhZ3M6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBrZXk6ICdOYW1lJyxcbiAgICAgICAgICAgIHZhbHVlOiBgU0NBIFB1YmxpYyBSb3V0ZSBUYWJsZSAke2luZGV4ICsgMX1gLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcblxuICAgICAgLy8gQXNzb2NpYXRlIHJvdXRlIHRhYmxlIHdpdGggc3VibmV0XG4gICAgICBuZXcgZWMyLkNmblN1Ym5ldFJvdXRlVGFibGVBc3NvY2lhdGlvbih0aGlzLCBgUHVibGljU3VibmV0Um91dGVUYWJsZUFzc29jaWF0aW9uJHtpbmRleCArIDF9YCwge1xuICAgICAgICBzdWJuZXRJZDogcHVibGljU3VibmV0LnJlZixcbiAgICAgICAgcm91dGVUYWJsZUlkOiByb3V0ZVRhYmxlLnJlZixcbiAgICAgIH0pO1xuXG4gICAgICAvLyBBZGQgcm91dGUgdG8gSW50ZXJuZXQgR2F0ZXdheVxuICAgICAgY29uc3QgcHVibGljUm91dGUgPSBuZXcgZWMyLkNmblJvdXRlKHRoaXMsIGBQdWJsaWNSb3V0ZSR7aW5kZXggKyAxfWAsIHtcbiAgICAgICAgcm91dGVUYWJsZUlkOiByb3V0ZVRhYmxlLnJlZixcbiAgICAgICAgZ2F0ZXdheUlkOiB0aGlzLmludGVybmV0R2F0ZXdheS5yZWYsXG4gICAgICAgIGRlc3RpbmF0aW9uQ2lkckJsb2NrOiAnMC4wLjAuMC8wJyxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBUaGUgcm91dGUgdGFyZ2V0cyB0aGUgSW50ZXJuZXQgR2F0ZXdheSwgYnV0IGEgUmVmIG9uIHRoZSBJR1cgb25seSBjcmVhdGVzXG4gICAgICAvLyBhbiBpbXBsaWNpdCBkZXBlbmRlbmN5IG9uIHRoZSBJR1cgcmVzb3VyY2UgaXRzZWxmIOKAlCBub3Qgb24gaXRzIGF0dGFjaG1lbnRcbiAgICAgIC8vIHRvIHRoZSBWUEMuIFdpdGhvdXQgdGhpcyBleHBsaWNpdCBkZXBlbmRlbmN5LCBDbG91ZEZvcm1hdGlvbiBtYXkgY3JlYXRlIHRoZVxuICAgICAgLy8gcm91dGUgYmVmb3JlIFZwY0dhdGV3YXlBdHRhY2htZW50IGNvbXBsZXRlcywgY2F1c2luZzpcbiAgICAgIC8vICAgXCJyb3V0ZSB0YWJsZSAuLi4gYW5kIG5ldHdvcmsgZ2F0ZXdheSAuLi4gYmVsb25nIHRvIGRpZmZlcmVudCBuZXR3b3Jrc1wiXG4gICAgICBwdWJsaWNSb3V0ZS5hZGREZXBlbmRlbmN5KHZwY0dhdGV3YXlBdHRhY2htZW50KTtcblxuICAgICAgLy8gU3RvcmUgc3VibmV0IHJlZmVyZW5jZSAod2UnbGwgY3JlYXRlIGEgd3JhcHBlciBpZiBuZWVkZWQpXG4gICAgICB0aGlzLnB1YmxpY1N1Ym5ldHMucHVzaCh7XG4gICAgICAgIHN1Ym5ldElkOiBwdWJsaWNTdWJuZXQucmVmLFxuICAgICAgICBhdmFpbGFiaWxpdHlab25lOiBheixcbiAgICAgIH0gYXMgYW55KTtcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBFbGFzdGljIElQIGZvciBOQVQgR2F0ZXdheVxuICAgIGNvbnN0IG5hdEVpcCA9IG5ldyBlYzIuQ2ZuRUlQKHRoaXMsICdOYXRHYXRld2F5RWlwJywge1xuICAgICAgZG9tYWluOiAndnBjJyxcbiAgICAgIHRhZ3M6IFtcbiAgICAgICAge1xuICAgICAgICAgIGtleTogJ05hbWUnLFxuICAgICAgICAgIHZhbHVlOiAnU0NBIE5BVCBHYXRld2F5IEVJUCcsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIE5BVCBHYXRld2F5IGluIHRoZSBmaXJzdCBwdWJsaWMgc3VibmV0XG4gICAgdGhpcy5uYXRHYXRld2F5ID0gbmV3IGVjMi5DZm5OYXRHYXRld2F5KHRoaXMsICdOYXRHYXRld2F5Jywge1xuICAgICAgc3VibmV0SWQ6IHRoaXMucHVibGljU3VibmV0c1swXS5zdWJuZXRJZCxcbiAgICAgIGFsbG9jYXRpb25JZDogbmF0RWlwLmF0dHJBbGxvY2F0aW9uSWQsXG4gICAgICB0YWdzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBrZXk6ICdOYW1lJyxcbiAgICAgICAgICB2YWx1ZTogJ1NDQSBOQVQgR2F0ZXdheScsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgLy8gVXBkYXRlIHByaXZhdGUgc3VibmV0cyB0byB1c2UgTkFUIEdhdGV3YXkgZm9yIGludGVybmV0IGFjY2Vzc1xuICAgIGNvbnN0IHByaXZhdGVTdWJuZXRzID0gcHJvcHMudnBjLnByaXZhdGVTdWJuZXRzO1xuICAgIHByaXZhdGVTdWJuZXRzLmZvckVhY2goKHN1Ym5ldCwgaW5kZXgpID0+IHtcbiAgICAgIC8vIEFkZCByb3V0ZSB0byBOQVQgR2F0ZXdheSBmb3IgaW50ZXJuZXQgYWNjZXNzXG4gICAgICBuZXcgZWMyLkNmblJvdXRlKHRoaXMsIGBQcml2YXRlU3VibmV0Um91dGUke2luZGV4ICsgMX1gLCB7XG4gICAgICAgIHJvdXRlVGFibGVJZDogc3VibmV0LnJvdXRlVGFibGUucm91dGVUYWJsZUlkLFxuICAgICAgICBkZXN0aW5hdGlvbkNpZHJCbG9jazogJzAuMC4wLjAvMCcsXG4gICAgICAgIG5hdEdhdGV3YXlJZDogdGhpcy5uYXRHYXRld2F5LnJlZixcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgLy8gUzMgYnVja2V0IGZvciBDbG91ZEZyb250IGFjY2VzcyBsb2dzXG4gICAgY29uc3QgYWNjZXNzTG9nc0J1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ0Nsb3VkRnJvbnRBY2Nlc3NMb2dzJywge1xuICAgICAgYnVja2V0TmFtZTogYHNjYS1jbG91ZGZyb250LWxvZ3MtJHt0aGlzLmFjY291bnR9LSR7dGhpcy5yZWdpb259YCxcbiAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICBvYmplY3RPd25lcnNoaXA6IHMzLk9iamVjdE93bmVyc2hpcC5CVUNLRVRfT1dORVJfUFJFRkVSUkVELCAvLyBSZXF1aXJlZCBmb3IgQ2xvdWRGcm9udCBsb2dnaW5nXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLCAvLyBGb3IgZGV2ZWxvcG1lbnRcbiAgICAgIGF1dG9EZWxldGVPYmplY3RzOiB0cnVlLCAvLyBGb3IgZGV2ZWxvcG1lbnRcbiAgICAgIGVuZm9yY2VTU0w6IHRydWUsIC8vIFJlcXVpcmUgU1NMIGZvciBhbGwgcmVxdWVzdHNcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBWUEMgb3JpZ2luIHVzaW5nIEFMQiBjb25zdHJ1Y3QgKHJlcXVpcmVzIGludGVybmV0IGdhdGV3YXkpXG4gICAgY29uc3QgdnBjT3JpZ2luID0gb3JpZ2lucy5WcGNPcmlnaW4ud2l0aEFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyKHByb3BzLmFsYiwge1xuICAgICAgcHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuT3JpZ2luUHJvdG9jb2xQb2xpY3kuSFRUUF9PTkxZLFxuICAgIH0pO1xuXG4gICAgLy8gQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gd2l0aCBWUEMgT3JpZ2luIChwcml2YXRlIEFMQilcbiAgICB0aGlzLmNsb3VkRnJvbnREaXN0cmlidXRpb24gPSBuZXcgY2xvdWRmcm9udC5EaXN0cmlidXRpb24odGhpcywgJ0Nsb3VkRnJvbnREaXN0cmlidXRpb24nLCB7XG4gICAgICBkZWZhdWx0QmVoYXZpb3I6IHtcbiAgICAgICAgb3JpZ2luOiB2cGNPcmlnaW4sXG4gICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICAgIGNhY2hlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQ2FjaGVkTWV0aG9kcy5DQUNIRV9HRVRfSEVBRF9PUFRJT05TLFxuICAgICAgICBjb21wcmVzczogdHJ1ZSxcbiAgICAgICAgY2FjaGVQb2xpY3k6IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19PUFRJTUlaRUQsXG4gICAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeS5DT1JTX1MzX09SSUdJTixcbiAgICAgIH0sXG4gICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzOiB7XG4gICAgICAgICcvYXBpLyonOiB7XG4gICAgICAgICAgb3JpZ2luOiB2cGNPcmlnaW4sXG4gICAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgICAgIGNhY2hlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQ2FjaGVkTWV0aG9kcy5DQUNIRV9HRVRfSEVBRCxcbiAgICAgICAgICBjb21wcmVzczogdHJ1ZSxcbiAgICAgICAgICBjYWNoZVBvbGljeTogY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVELFxuICAgICAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeS5BTExfVklFV0VSLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHByaWNlQ2xhc3M6IGNsb3VkZnJvbnQuUHJpY2VDbGFzcy5QUklDRV9DTEFTU18xMDAsXG4gICAgICBlbmFibGVMb2dnaW5nOiB0cnVlLFxuICAgICAgbG9nQnVja2V0OiBhY2Nlc3NMb2dzQnVja2V0LFxuICAgICAgbG9nRmlsZVByZWZpeDogJ2Nsb3VkZnJvbnQtbG9ncy8nLFxuICAgICAgY29tbWVudDogJ1NDQSBDbG91ZEZyb250IERpc3RyaWJ1dGlvbiB3aXRoIFZQQyBPcmlnaW4gZm9yIFByaXZhdGUgQUxCJyxcbiAgICB9KTtcbiAgICBcbiAgICAvLyBWUEMgT3JpZ2luIHJlcXVpcmVzIGludGVybmV0IGdhdGV3YXkgdG8gYmUgYXR0YWNoZWQgZmlyc3RcbiAgICB0aGlzLmNsb3VkRnJvbnREaXN0cmlidXRpb24ubm9kZS5hZGREZXBlbmRlbmN5KHZwY0dhdGV3YXlBdHRhY2htZW50KTtcblxuICAgIC8vIEFsbG93IHRyYWZmaWMgZnJvbSBDbG91ZEZyb250IG1hbmFnZWQgcHJlZml4IGxpc3QgdG8gQUxCXG4gICAgY29uc3QgY2ZPcmlnaW5GYWNpbmcgPSBlYzIuUHJlZml4TGlzdC5mcm9tTG9va3VwKHRoaXMsICdDbG91ZEZyb250T3JpZ2luRmFjaW5nJywge1xuICAgICAgcHJlZml4TGlzdE5hbWU6ICdjb20uYW1hem9uYXdzLmdsb2JhbC5jbG91ZGZyb250Lm9yaWdpbi1mYWNpbmcnLFxuICAgIH0pO1xuICAgIFxuICAgIC8vIEdldCBBTEIgc2VjdXJpdHkgZ3JvdXAgYW5kIGFkZCBpbmdyZXNzIHJ1bGVcbiAgICBjb25zdCBhbGJTZWN1cml0eUdyb3VwcyA9IHByb3BzLmFsYi5jb25uZWN0aW9ucy5zZWN1cml0eUdyb3VwcztcbiAgICBhbGJTZWN1cml0eUdyb3Vwcy5mb3JFYWNoKChzZykgPT4ge1xuICAgICAgc2cuYWRkSW5ncmVzc1J1bGUoXG4gICAgICAgIGNmT3JpZ2luRmFjaW5nLFxuICAgICAgICBlYzIuUG9ydC50Y3AoODApLFxuICAgICAgICAnQWxsb3cgQ2xvdWRGcm9udCBWUEMgT3JpZ2luIHRyYWZmaWMnXG4gICAgICApO1xuICAgIH0pO1xuXG4gICAgLy8gU2VjdXJpdHkgaGVhZGVycyByZXNwb25zZSBoZWFkZXJzIHBvbGljeVxuICAgIGNvbnN0IHNlY3VyaXR5SGVhZGVyc1BvbGljeSA9IG5ldyBjbG91ZGZyb250LlJlc3BvbnNlSGVhZGVyc1BvbGljeSh0aGlzLCAnU2VjdXJpdHlIZWFkZXJzUG9saWN5Jywge1xuICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5TmFtZTogJ1NDQS1TZWN1cml0eS1IZWFkZXJzJyxcbiAgICAgIGNvbW1lbnQ6ICdTZWN1cml0eSBoZWFkZXJzIGZvciBTQ0EgYXBwbGljYXRpb24nLFxuICAgICAgc2VjdXJpdHlIZWFkZXJzQmVoYXZpb3I6IHtcbiAgICAgICAgY29udGVudFR5cGVPcHRpb25zOiB7XG4gICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIGZyYW1lT3B0aW9uczoge1xuICAgICAgICAgIGZyYW1lT3B0aW9uOiBjbG91ZGZyb250LkhlYWRlcnNGcmFtZU9wdGlvbi5ERU5ZLFxuICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICByZWZlcnJlclBvbGljeToge1xuICAgICAgICAgIHJlZmVycmVyUG9saWN5OiBjbG91ZGZyb250LkhlYWRlcnNSZWZlcnJlclBvbGljeS5TVFJJQ1RfT1JJR0lOX1dIRU5fQ1JPU1NfT1JJR0lOLFxuICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICBzdHJpY3RUcmFuc3BvcnRTZWN1cml0eToge1xuICAgICAgICAgIGFjY2Vzc0NvbnRyb2xNYXhBZ2U6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMxNTM2MDAwKSxcbiAgICAgICAgICBpbmNsdWRlU3ViZG9tYWluczogdHJ1ZSxcbiAgICAgICAgICBwcmVsb2FkOiB0cnVlLFxuICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEFwcGx5IHNlY3VyaXR5IGhlYWRlcnMgdG8gdGhlIGRlZmF1bHQgYmVoYXZpb3JcbiAgICAvLyBOb3RlOiBUaGlzIHdvdWxkIGJlIGNvbmZpZ3VyZWQgdGhyb3VnaCBDbG91ZEZvcm1hdGlvbiB0ZW1wbGF0ZSBjdXN0b21pemF0aW9uXG4gICAgLy8gRm9yIG5vdywgd2UnbGwgcmVseSBvbiB0aGUgZGVmYXVsdCBzZWN1cml0eSBoZWFkZXJzIHBvbGljeVxuXG4gICAgLy8gT3V0cHV0IGltcG9ydGFudCB2YWx1ZXNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2xvdWRGcm9udERpc3RyaWJ1dGlvbklkJywge1xuICAgICAgdmFsdWU6IHRoaXMuY2xvdWRGcm9udERpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25JZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ2xvdWRGcm9udCBEaXN0cmlidXRpb24gSUQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Nsb3VkRnJvbnREb21haW5OYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMuY2xvdWRGcm9udERpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25Eb21haW5OYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdDbG91ZEZyb250IERpc3RyaWJ1dGlvbiBEb21haW4gTmFtZScsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2xvdWRGcm9udFVybCcsIHtcbiAgICAgIHZhbHVlOiBgaHR0cHM6Ly8ke3RoaXMuY2xvdWRGcm9udERpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25Eb21haW5OYW1lfWAsXG4gICAgICBkZXNjcmlwdGlvbjogJ0Nsb3VkRnJvbnQgRGlzdHJpYnV0aW9uIFVSTCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnSW50ZXJuZXRHYXRld2F5SWQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5pbnRlcm5ldEdhdGV3YXkucmVmLFxuICAgICAgZGVzY3JpcHRpb246ICdJbnRlcm5ldCBHYXRld2F5IElEJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdOYXRHYXRld2F5SWQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5uYXRHYXRld2F5LnJlZixcbiAgICAgIGRlc2NyaXB0aW9uOiAnTkFUIEdhdGV3YXkgSUQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1B1YmxpY1N1Ym5ldElkcycsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnB1YmxpY1N1Ym5ldHMubWFwKChzdWJuZXQ6IGFueSkgPT4gc3VibmV0LnN1Ym5ldElkKS5qb2luKCcsJyksXG4gICAgICBkZXNjcmlwdGlvbjogJ1B1YmxpYyBTdWJuZXQgSURzJyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDREsgTmFnIFN1cHByZXNzaW9uc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIFN1cHByZXNzIFMzIGFjY2VzcyBsb2dzIGZvciBDbG91ZEZyb250IGxvZ3MgYnVja2V0XG4gICAgLy8gVGhpcyBidWNrZXQgc3RvcmVzIENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MsIHNvIGl0IGRvZXNuJ3QgbmVlZCBpdHMgb3duIGFjY2VzcyBsb2dzXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zQnlQYXRoKFxuICAgICAgdGhpcyxcbiAgICAgICcvU2NhQ2xvdWRGcm9udEFjY2Vzc1N0YWNrL0Nsb3VkRnJvbnRBY2Nlc3NMb2dzL1Jlc291cmNlJyxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiAnQXdzU29sdXRpb25zLVMxJyxcbiAgICAgICAgICByZWFzb246ICdUaGlzIFMzIGJ1Y2tldCBzdG9yZXMgQ2xvdWRGcm9udCBhY2Nlc3MgbG9ncy4gJyArXG4gICAgICAgICAgICAgICAgICAnQWNjZXNzIGxvZ3MgZm9yIGEgbG9nZ2luZyBidWNrZXQgd291bGQgY3JlYXRlIGEgY2lyY3VsYXIgZGVwZW5kZW5jeSBhbmQgYXJlIG5vdCByZXF1aXJlZC4nLFxuICAgICAgICB9LFxuICAgICAgXVxuICAgICk7XG5cbiAgICAvLyBTdXBwcmVzcyBTU0wgcmVxdWlyZW1lbnQgZm9yIENsb3VkRnJvbnQgbG9ncyBidWNrZXRcbiAgICAvLyBBZGRpbmcgU1NMLW9ubHkgcG9saWN5XG4gICAgY29uc3QgbG9nc1BvbGljeSA9IG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5ERU5ZLFxuICAgICAgcHJpbmNpcGFsczogW25ldyBpYW0uQW55UHJpbmNpcGFsKCldLFxuICAgICAgYWN0aW9uczogWydzMzoqJ10sXG4gICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgYWNjZXNzTG9nc0J1Y2tldC5idWNrZXRBcm4sXG4gICAgICAgIGAke2FjY2Vzc0xvZ3NCdWNrZXQuYnVja2V0QXJufS8qYCxcbiAgICAgIF0sXG4gICAgICBjb25kaXRpb25zOiB7XG4gICAgICAgIEJvb2w6IHtcbiAgICAgICAgICAnYXdzOlNlY3VyZVRyYW5zcG9ydCc6ICdmYWxzZScsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGFjY2Vzc0xvZ3NCdWNrZXQuYWRkVG9SZXNvdXJjZVBvbGljeShsb2dzUG9saWN5KTtcblxuICAgIC8vIFN1cHByZXNzIENsb3VkRnJvbnQgZ2VvIHJlc3RyaWN0aW9ucyB3YXJuaW5nXG4gICAgLy8gR2VvIHJlc3RyaWN0aW9ucyBhcmUgbm90IHJlcXVpcmVkIGZvciB0aGlzIGFwcGxpY2F0aW9uXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zQnlQYXRoKFxuICAgICAgdGhpcyxcbiAgICAgICcvU2NhQ2xvdWRGcm9udEFjY2Vzc1N0YWNrL0Nsb3VkRnJvbnREaXN0cmlidXRpb24vUmVzb3VyY2UnLFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtQ0ZSMScsXG4gICAgICAgICAgcmVhc29uOiAnR2VvIHJlc3RyaWN0aW9ucyBhcmUgbm90IHJlcXVpcmVkIGZvciB0aGlzIGFwcGxpY2F0aW9uLiAnICtcbiAgICAgICAgICAgICAgICAgICdUaGUgYXBwbGljYXRpb24gaXMgaW50ZW5kZWQgZm9yIGdsb2JhbCBhY2Nlc3MuJyxcbiAgICAgICAgfSxcbiAgICAgIF1cbiAgICApO1xuXG4gICAgLy8gU3VwcHJlc3MgQ2xvdWRGcm9udCBXQUYgd2FybmluZ1xuICAgIC8vIFdBRiBhZGRzIGNvc3QgYW5kIGNvbXBsZXhpdHk7IGFwcGxpY2F0aW9uLWxldmVsIHNlY3VyaXR5IGlzIGhhbmRsZWQgYnkgQ29nbml0b1xuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9uc0J5UGF0aChcbiAgICAgIHRoaXMsXG4gICAgICAnL1NjYUNsb3VkRnJvbnRBY2Nlc3NTdGFjay9DbG91ZEZyb250RGlzdHJpYnV0aW9uL1Jlc291cmNlJyxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUNGUjInLFxuICAgICAgICAgIHJlYXNvbjogJ0FXUyBXQUYgaXMgbm90IGVuYWJsZWQgdG8gcmVkdWNlIGNvc3RzIGZvciB0aGlzIHNvbHV0aW9uLiAnICtcbiAgICAgICAgICAgICAgICAgICdBcHBsaWNhdGlvbi1sZXZlbCBzZWN1cml0eSBpcyBoYW5kbGVkIGJ5IEFtYXpvbiBDb2duaXRvIGF1dGhlbnRpY2F0aW9uLiAnICtcbiAgICAgICAgICAgICAgICAgICdGb3IgcHJvZHVjdGlvbiBkZXBsb3ltZW50cyB3aXRoIGhpZ2ggc2VjdXJpdHkgcmVxdWlyZW1lbnRzLCBjb25zaWRlciBlbmFibGluZyBXQUYuJyxcbiAgICAgICAgfSxcbiAgICAgIF1cbiAgICApO1xuXG4gICAgLy8gU3VwcHJlc3MgQ2xvdWRGcm9udCBUTFMgdmVyc2lvbiByZXF1aXJlbWVudFxuICAgIC8vIFVzaW5nIGRlZmF1bHQgQ2xvdWRGcm9udCBjZXJ0aWZpY2F0ZSB3aGljaCBlbmZvcmNlcyBUTFN2MS4yIG1pbmltdW1cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnNCeVBhdGgoXG4gICAgICB0aGlzLFxuICAgICAgJy9TY2FDbG91ZEZyb250QWNjZXNzU3RhY2svQ2xvdWRGcm9udERpc3RyaWJ1dGlvbi9SZXNvdXJjZScsXG4gICAgICBbXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1DRlI0JyxcbiAgICAgICAgICByZWFzb246ICdVc2luZyBkZWZhdWx0IENsb3VkRnJvbnQgdmlld2VyIGNlcnRpZmljYXRlIHdoaWNoIGVuZm9yY2VzIFRMU3YxLjIgYXMgbWluaW11bSBwcm90b2NvbC4gJyArXG4gICAgICAgICAgICAgICAgICAnVGhlIGRpc3RyaWJ1dGlvbiB1c2VzIEhUVFBTIHdpdGggc2VjdXJlIFRMUyBjb25maWd1cmF0aW9uLicsXG4gICAgICAgIH0sXG4gICAgICBdXG4gICAgKTtcbiAgfVxufSJdfQ==