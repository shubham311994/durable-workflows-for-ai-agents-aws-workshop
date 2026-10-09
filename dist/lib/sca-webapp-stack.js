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
exports.ScaWebAppStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const ecs = __importStar(require("aws-cdk-lib/aws-ecs"));
const elbv2 = __importStar(require("aws-cdk-lib/aws-elasticloadbalancingv2"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const cdk_nag_1 = require("cdk-nag");
/**
 * ScaWebAppStack - Web application infrastructure for the SCA solution
 *
 * This stack contains:
 * - ECS cluster and Fargate service
 * - Application Load Balancer (private)
 * - Auto-scaling configuration
 *
 * Prerequisites:
 * - ECR repository must exist (created by ScaEcrStack)
 * - Docker image must be pushed to ECR before deploying this stack
 *
 * Resources are exposed via public readonly properties for use by other stacks.
 * NO CloudFormation exports are used to avoid cross-stack dependencies.
 */
class ScaWebAppStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // ECR Repository for web application images
        this.ecsCluster = new ecs.Cluster(this, 'EcsCluster', {
            clusterName: 'sca-cluster',
            vpc: props.vpc,
            containerInsights: true,
        });
        // Security group for ALB
        this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
            vpc: props.vpc,
            description: 'Security group for SCA Application Load Balancer',
            allowAllOutbound: true,
        });
        // Private Application Load Balancer (in isolated subnets)
        this.alb = new elbv2.ApplicationLoadBalancer(this, 'PrivateAlb', {
            vpc: props.vpc,
            internetFacing: false,
            securityGroup: this.albSecurityGroup,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
        });
        // Lock logical ID to prevent breaking changes
        this.alb.node.defaultChild.overrideLogicalId('PrivateAlbF07A94D5');
        // Security group for ECS tasks
        const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
            vpc: props.vpc,
            description: 'Security group for SCA ECS tasks',
            allowAllOutbound: true,
        });
        // Allow ALB to communicate with ECS tasks
        ecsSecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(3000), 'Allow ALB to reach ECS tasks');
        // IAM role for ECS task execution (pull images, write logs)
        const taskExecutionRole = new iam.Role(this, 'EcsTaskExecutionRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
            ],
        });
        // Grant ECR pull permissions
        props.ecrRepository.grantPull(taskExecutionRole);
        // IAM role for ECS task (application permissions)
        const taskRole = new iam.Role(this, 'EcsTaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });
        // ECS Task Definition
        const useArm = this.node.tryGetContext('arm') === true || this.node.tryGetContext('arm') === 'true';
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'WebAppTaskDefinition', {
            family: 'sca-web-app',
            cpu: 256,
            memoryLimitMiB: 512,
            executionRole: taskExecutionRole,
            taskRole: taskRole,
            ...(useArm && {
                runtimePlatform: {
                    cpuArchitecture: ecs.CpuArchitecture.ARM64,
                    operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
                },
            }),
        });
        // Add container to task definition
        const container = taskDefinition.addContainer('WebAppContainer', {
            containerName: 'sca-web-app',
            image: ecs.ContainerImage.fromEcrRepository(props.ecrRepository, 'latest'),
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'sca-web-app',
                logRetention: 7,
            }),
            environment: {
                // React build-time environment variables
                REACT_APP_USER_POOL_ID: props.cognitoUserPool.userPoolId,
                REACT_APP_USER_POOL_CLIENT_ID: props.cognitoUserPoolClient.userPoolClientId,
                REACT_APP_API_ENDPOINT: `https://${props.dataRetrievalApi.restApiId}.execute-api.${this.region}.amazonaws.com/prod/`,
                REACT_APP_AWS_REGION: this.region,
                // Nginx runtime environment variables for API proxy
                API_ENDPOINT: `https://${props.dataRetrievalApi.restApiId}-${props.apiGatewayVpcEndpoint.vpcEndpointId}.execute-api.${this.region}.amazonaws.com/prod/`,
                API_HOST: `${props.dataRetrievalApi.restApiId}-${props.apiGatewayVpcEndpoint.vpcEndpointId}.execute-api.${this.region}.amazonaws.com`,
                // Deploy timestamp forces a new task definition revision on each deploy,
                // ensuring ECS pulls the latest image from ECR
                DEPLOY_TIMESTAMP: new Date().toISOString(),
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
            desiredCount: 2,
            minHealthyPercent: 50,
            maxHealthyPercent: 200,
            securityGroups: [ecsSecurityGroup],
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
            enableExecuteCommand: true,
            circuitBreaker: {
                rollback: true,
            },
        });
        // ALB Target Group for ECS Service
        const targetGroup = new elbv2.ApplicationTargetGroup(this, 'WebAppTargetGroup', {
            vpc: props.vpc,
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
        this.alb.addListener('HttpListener', {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.forward([targetGroup]),
            open: false,
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
        // CloudFormation Outputs (NO EXPORTS)
        // ========================================
        new cdk.CfnOutput(this, 'AlbDnsName', {
            value: this.alb.loadBalancerDnsName,
            description: 'Private ALB DNS name',
        });
        new cdk.CfnOutput(this, 'AlbSecurityGroupId', {
            value: this.albSecurityGroup.securityGroupId,
            description: 'ALB Security Group ID',
        });
        new cdk.CfnOutput(this, 'EcsClusterName', {
            value: this.ecsCluster.clusterName,
            description: 'ECS Cluster name',
        });
        // ========================================
        // CDK Nag Suppressions
        // ========================================
        // Suppress wildcard permissions for ECS Task Execution Role
        // ECS tasks require wildcard permissions for ECR and CloudWatch Logs
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaWebAppStack/EcsTaskExecutionRole/DefaultPolicy/Resource', [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'ECS Task Execution Role requires wildcard permissions for: ' +
                    '1) ECR image pull (ecr:GetAuthorizationToken requires Resource: "*") ' +
                    '2) CloudWatch Logs (logs:CreateLogStream and logs:PutLogEvents require wildcard for runtime log group creation) ' +
                    'See: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_execution_IAM_role.html',
                appliesTo: ['Resource::*'],
            },
        ]);
        // Suppress wildcard permissions for ECS Task Role
        // Task role needs wildcard for CloudWatch Logs and X-Ray tracing
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaWebAppStack/EcsTaskRole/DefaultPolicy/Resource', [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'ECS Task Role requires wildcard permissions for CloudWatch Logs and X-Ray tracing. ' +
                    'These services require Resource: "*" for runtime log group and trace segment creation.',
                appliesTo: ['Resource::*'],
            },
        ]);
        // Suppress AWS managed policy for ECS Task Execution
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaWebAppStack/EcsTaskExecutionRole/Resource', [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'AmazonECSTaskExecutionRolePolicy is the AWS recommended managed policy for ECS task execution. ' +
                    'It provides necessary permissions for ECR image pull and CloudWatch Logs. ' +
                    'See: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_execution_IAM_role.html',
                appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'],
            },
        ]);
        // Suppress ECS environment variables warning
        // The environment variables contain non-sensitive configuration (Cognito IDs, API endpoints)
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaWebAppStack/WebAppTaskDefinition/Resource', [
            {
                id: 'AwsSolutions-ECS2',
                reason: 'Environment variables contain non-sensitive configuration data: ' +
                    'Cognito User Pool ID, Client ID, AWS Region, and API endpoints. ' +
                    'These are public identifiers and do not require Secrets Manager. ' +
                    'Sensitive data like credentials are managed through IAM roles.',
            },
        ]);
        // Suppress ALB access logs requirement
        // Access logs add operational overhead and cost for private ALB
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/ScaWebAppStack/PrivateAlb/Resource', [
            {
                id: 'AwsSolutions-ELB2',
                reason: 'ALB access logs are not enabled to reduce operational overhead and costs. ' +
                    'This is a private ALB not exposed to the internet. ' +
                    'For production deployments, enable access logs for traffic analysis and troubleshooting.',
            },
        ]);
    }
}
exports.ScaWebAppStack = ScaWebAppStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NhLXdlYmFwcC1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2luZnJhc3RydWN0dXJlL2xpYi9zY2Etd2ViYXBwLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLGlEQUFtQztBQUNuQyx5REFBMkM7QUFDM0MseURBQTJDO0FBQzNDLDhFQUFnRTtBQUdoRSx5REFBMkM7QUFHM0MscUNBQTBDO0FBVzFDOzs7Ozs7Ozs7Ozs7OztHQWNHO0FBQ0gsTUFBYSxjQUFlLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFLM0MsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUEwQjtRQUNsRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4Qiw0Q0FBNEM7UUFDNUMsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLEdBQUcsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNwRCxXQUFXLEVBQUUsYUFBYTtZQUMxQixHQUFHLEVBQUUsS0FBSyxDQUFDLEdBQUc7WUFDZCxpQkFBaUIsRUFBRSxJQUFJO1NBQ3hCLENBQUMsQ0FBQztRQUVILHlCQUF5QjtRQUN6QixJQUFJLENBQUMsZ0JBQWdCLEdBQUcsSUFBSSxHQUFHLENBQUMsYUFBYSxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtZQUN0RSxHQUFHLEVBQUUsS0FBSyxDQUFDLEdBQUc7WUFDZCxXQUFXLEVBQUUsa0RBQWtEO1lBQy9ELGdCQUFnQixFQUFFLElBQUk7U0FDdkIsQ0FBQyxDQUFDO1FBRUgsMERBQTBEO1FBQzFELElBQUksQ0FBQyxHQUFHLEdBQUcsSUFBSSxLQUFLLENBQUMsdUJBQXVCLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUMvRCxHQUFHLEVBQUUsS0FBSyxDQUFDLEdBQUc7WUFDZCxjQUFjLEVBQUUsS0FBSztZQUNyQixhQUFhLEVBQUUsSUFBSSxDQUFDLGdCQUFnQjtZQUNwQyxVQUFVLEVBQUU7Z0JBQ1YsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsZ0JBQWdCO2FBQzVDO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsOENBQThDO1FBQzdDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFlBQXNDLENBQUMsaUJBQWlCLENBQUMsb0JBQW9CLENBQUMsQ0FBQztRQUU5RiwrQkFBK0I7UUFDL0IsTUFBTSxnQkFBZ0IsR0FBRyxJQUFJLEdBQUcsQ0FBQyxhQUFhLENBQUMsSUFBSSxFQUFFLGtCQUFrQixFQUFFO1lBQ3ZFLEdBQUcsRUFBRSxLQUFLLENBQUMsR0FBRztZQUNkLFdBQVcsRUFBRSxrQ0FBa0M7WUFDL0MsZ0JBQWdCLEVBQUUsSUFBSTtTQUN2QixDQUFDLENBQUM7UUFFSCwwQ0FBMEM7UUFDMUMsZ0JBQWdCLENBQUMsY0FBYyxDQUM3QixJQUFJLENBQUMsZ0JBQWdCLEVBQ3JCLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUNsQiw4QkFBOEIsQ0FDL0IsQ0FBQztRQUVGLDREQUE0RDtRQUM1RCxNQUFNLGlCQUFpQixHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsc0JBQXNCLEVBQUU7WUFDbkUsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLHlCQUF5QixDQUFDO1lBQzlELGVBQWUsRUFBRTtnQkFDZixHQUFHLENBQUMsYUFBYSxDQUFDLHdCQUF3QixDQUFDLCtDQUErQyxDQUFDO2FBQzVGO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsNkJBQTZCO1FBQzdCLEtBQUssQ0FBQyxhQUFhLENBQUMsU0FBUyxDQUFDLGlCQUFpQixDQUFDLENBQUM7UUFFakQsa0RBQWtEO1FBQ2xELE1BQU0sUUFBUSxHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO1lBQ2pELFNBQVMsRUFBRSxJQUFJLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyx5QkFBeUIsQ0FBQztTQUMvRCxDQUFDLENBQUM7UUFFSCxzQkFBc0I7UUFDdEIsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsS0FBSyxDQUFDLEtBQUssSUFBSSxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLEtBQUssQ0FBQyxLQUFLLE1BQU0sQ0FBQztRQUVwRyxNQUFNLGNBQWMsR0FBRyxJQUFJLEdBQUcsQ0FBQyxxQkFBcUIsQ0FBQyxJQUFJLEVBQUUsc0JBQXNCLEVBQUU7WUFDakYsTUFBTSxFQUFFLGFBQWE7WUFDckIsR0FBRyxFQUFFLEdBQUc7WUFDUixjQUFjLEVBQUUsR0FBRztZQUNuQixhQUFhLEVBQUUsaUJBQWlCO1lBQ2hDLFFBQVEsRUFBRSxRQUFRO1lBQ2xCLEdBQUcsQ0FBQyxNQUFNLElBQUk7Z0JBQ1osZUFBZSxFQUFFO29CQUNmLGVBQWUsRUFBRSxHQUFHLENBQUMsZUFBZSxDQUFDLEtBQUs7b0JBQzFDLHFCQUFxQixFQUFFLEdBQUcsQ0FBQyxxQkFBcUIsQ0FBQyxLQUFLO2lCQUN2RDthQUNGLENBQUM7U0FDSCxDQUFDLENBQUM7UUFFSCxtQ0FBbUM7UUFDbkMsTUFBTSxTQUFTLEdBQUcsY0FBYyxDQUFDLFlBQVksQ0FBQyxpQkFBaUIsRUFBRTtZQUMvRCxhQUFhLEVBQUUsYUFBYTtZQUM1QixLQUFLLEVBQUUsR0FBRyxDQUFDLGNBQWMsQ0FBQyxpQkFBaUIsQ0FBQyxLQUFLLENBQUMsYUFBYSxFQUFFLFFBQVEsQ0FBQztZQUMxRSxPQUFPLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxPQUFPLENBQUM7Z0JBQzlCLFlBQVksRUFBRSxhQUFhO2dCQUMzQixZQUFZLEVBQUUsQ0FBQzthQUNoQixDQUFDO1lBQ0YsV0FBVyxFQUFFO2dCQUNYLHlDQUF5QztnQkFDekMsc0JBQXNCLEVBQUUsS0FBSyxDQUFDLGVBQWUsQ0FBQyxVQUFVO2dCQUN4RCw2QkFBNkIsRUFBRSxLQUFLLENBQUMscUJBQXFCLENBQUMsZ0JBQWdCO2dCQUMzRSxzQkFBc0IsRUFBRSxXQUFXLEtBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxTQUFTLGdCQUFnQixJQUFJLENBQUMsTUFBTSxzQkFBc0I7Z0JBQ3BILG9CQUFvQixFQUFFLElBQUksQ0FBQyxNQUFNO2dCQUNqQyxvREFBb0Q7Z0JBQ3BELFlBQVksRUFBRSxXQUFXLEtBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxTQUFTLElBQUksS0FBSyxDQUFDLHFCQUFxQixDQUFDLGFBQWEsZ0JBQWdCLElBQUksQ0FBQyxNQUFNLHNCQUFzQjtnQkFDdkosUUFBUSxFQUFFLEdBQUcsS0FBSyxDQUFDLGdCQUFnQixDQUFDLFNBQVMsSUFBSSxLQUFLLENBQUMscUJBQXFCLENBQUMsYUFBYSxnQkFBZ0IsSUFBSSxDQUFDLE1BQU0sZ0JBQWdCO2dCQUNySSx5RUFBeUU7Z0JBQ3pFLCtDQUErQztnQkFDL0MsZ0JBQWdCLEVBQUUsSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUU7YUFDM0M7WUFDRCxXQUFXLEVBQUU7Z0JBQ1gsT0FBTyxFQUFFLENBQUMsV0FBVyxFQUFFLGdEQUFnRCxDQUFDO2dCQUN4RSxRQUFRLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO2dCQUNsQyxPQUFPLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO2dCQUNoQyxPQUFPLEVBQUUsQ0FBQztnQkFDVixXQUFXLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO2FBQ3RDO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsbUJBQW1CO1FBQ25CLFNBQVMsQ0FBQyxlQUFlLENBQUM7WUFDeEIsYUFBYSxFQUFFLElBQUk7WUFDbkIsUUFBUSxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsR0FBRztTQUMzQixDQUFDLENBQUM7UUFFSCxjQUFjO1FBQ2QsTUFBTSxVQUFVLEdBQUcsSUFBSSxHQUFHLENBQUMsY0FBYyxDQUFDLElBQUksRUFBRSxlQUFlLEVBQUU7WUFDL0QsV0FBVyxFQUFFLHFCQUFxQjtZQUNsQyxPQUFPLEVBQUUsSUFBSSxDQUFDLFVBQVU7WUFDeEIsY0FBYyxFQUFFLGNBQWM7WUFDOUIsWUFBWSxFQUFFLENBQUM7WUFDZixpQkFBaUIsRUFBRSxFQUFFO1lBQ3JCLGlCQUFpQixFQUFFLEdBQUc7WUFDdEIsY0FBYyxFQUFFLENBQUMsZ0JBQWdCLENBQUM7WUFDbEMsVUFBVSxFQUFFO2dCQUNWLFVBQVUsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLGdCQUFnQjthQUM1QztZQUNELG9CQUFvQixFQUFFLElBQUk7WUFDMUIsY0FBYyxFQUFFO2dCQUNkLFFBQVEsRUFBRSxJQUFJO2FBQ2Y7U0FDRixDQUFDLENBQUM7UUFFSCxtQ0FBbUM7UUFDbkMsTUFBTSxXQUFXLEdBQUcsSUFBSSxLQUFLLENBQUMsc0JBQXNCLENBQUMsSUFBSSxFQUFFLG1CQUFtQixFQUFFO1lBQzlFLEdBQUcsRUFBRSxLQUFLLENBQUMsR0FBRztZQUNkLElBQUksRUFBRSxJQUFJO1lBQ1YsUUFBUSxFQUFFLEtBQUssQ0FBQyxtQkFBbUIsQ0FBQyxJQUFJO1lBQ3hDLFVBQVUsRUFBRSxLQUFLLENBQUMsVUFBVSxDQUFDLEVBQUU7WUFDL0IsV0FBVyxFQUFFO2dCQUNYLElBQUksRUFBRSxTQUFTO2dCQUNmLFFBQVEsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7Z0JBQ2xDLE9BQU8sRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7Z0JBQ2hDLHFCQUFxQixFQUFFLENBQUM7Z0JBQ3hCLHVCQUF1QixFQUFFLENBQUM7Z0JBQzFCLGdCQUFnQixFQUFFLEtBQUs7YUFDeEI7WUFDRCxtQkFBbUIsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7U0FDOUMsQ0FBQyxDQUFDO1FBRUgseUNBQXlDO1FBQ3pDLFVBQVUsQ0FBQyw4QkFBOEIsQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUV2RCxpQ0FBaUM7UUFDakMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsY0FBYyxFQUFFO1lBQ25DLElBQUksRUFBRSxFQUFFO1lBQ1IsUUFBUSxFQUFFLEtBQUssQ0FBQyxtQkFBbUIsQ0FBQyxJQUFJO1lBQ3hDLGFBQWEsRUFBRSxLQUFLLENBQUMsY0FBYyxDQUFDLE9BQU8sQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDO1lBQzFELElBQUksRUFBRSxLQUFLO1NBQ1osQ0FBQyxDQUFDO1FBRUgsNkJBQTZCO1FBQzdCLE1BQU0sT0FBTyxHQUFHLFVBQVUsQ0FBQyxrQkFBa0IsQ0FBQztZQUM1QyxXQUFXLEVBQUUsQ0FBQztZQUNkLFdBQVcsRUFBRSxFQUFFO1NBQ2hCLENBQUMsQ0FBQztRQUVILGlDQUFpQztRQUNqQyxPQUFPLENBQUMscUJBQXFCLENBQUMsWUFBWSxFQUFFO1lBQzFDLHdCQUF3QixFQUFFLEVBQUU7WUFDNUIsZUFBZSxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUN6QyxnQkFBZ0IsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7U0FDM0MsQ0FBQyxDQUFDO1FBRUgsb0NBQW9DO1FBQ3BDLE9BQU8sQ0FBQyx3QkFBd0IsQ0FBQyxlQUFlLEVBQUU7WUFDaEQsd0JBQXdCLEVBQUUsRUFBRTtZQUM1QixlQUFlLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQ3pDLGdCQUFnQixFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztTQUMzQyxDQUFDLENBQUM7UUFFSCwyQ0FBMkM7UUFDM0Msc0NBQXNDO1FBQ3RDLDJDQUEyQztRQUUzQyxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNwQyxLQUFLLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxtQkFBbUI7WUFDbkMsV0FBVyxFQUFFLHNCQUFzQjtTQUNwQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLG9CQUFvQixFQUFFO1lBQzVDLEtBQUssRUFBRSxJQUFJLENBQUMsZ0JBQWdCLENBQUMsZUFBZTtZQUM1QyxXQUFXLEVBQUUsdUJBQXVCO1NBQ3JDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLEVBQUU7WUFDeEMsS0FBSyxFQUFFLElBQUksQ0FBQyxVQUFVLENBQUMsV0FBVztZQUNsQyxXQUFXLEVBQUUsa0JBQWtCO1NBQ2hDLENBQUMsQ0FBQztRQUVILDJDQUEyQztRQUMzQyx1QkFBdUI7UUFDdkIsMkNBQTJDO1FBRTNDLDREQUE0RDtRQUM1RCxxRUFBcUU7UUFDckUseUJBQWUsQ0FBQyw2QkFBNkIsQ0FDM0MsSUFBSSxFQUNKLDZEQUE2RCxFQUM3RDtZQUNFO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSw2REFBNkQ7b0JBQzdELHVFQUF1RTtvQkFDdkUsa0hBQWtIO29CQUNsSCwrRkFBK0Y7Z0JBQ3ZHLFNBQVMsRUFBRSxDQUFDLGFBQWEsQ0FBQzthQUMzQjtTQUNGLENBQ0YsQ0FBQztRQUVGLGtEQUFrRDtRQUNsRCxpRUFBaUU7UUFDakUseUJBQWUsQ0FBQyw2QkFBNkIsQ0FDM0MsSUFBSSxFQUNKLG9EQUFvRCxFQUNwRDtZQUNFO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSxxRkFBcUY7b0JBQ3JGLHdGQUF3RjtnQkFDaEcsU0FBUyxFQUFFLENBQUMsYUFBYSxDQUFDO2FBQzNCO1NBQ0YsQ0FDRixDQUFDO1FBRUYscURBQXFEO1FBQ3JELHlCQUFlLENBQUMsNkJBQTZCLENBQzNDLElBQUksRUFDSiwrQ0FBK0MsRUFDL0M7WUFDRTtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsaUdBQWlHO29CQUNqRyw0RUFBNEU7b0JBQzVFLCtGQUErRjtnQkFDdkcsU0FBUyxFQUFFLENBQUMsNEZBQTRGLENBQUM7YUFDMUc7U0FDRixDQUNGLENBQUM7UUFFRiw2Q0FBNkM7UUFDN0MsNkZBQTZGO1FBQzdGLHlCQUFlLENBQUMsNkJBQTZCLENBQzNDLElBQUksRUFDSiwrQ0FBK0MsRUFDL0M7WUFDRTtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsa0VBQWtFO29CQUNsRSxrRUFBa0U7b0JBQ2xFLG1FQUFtRTtvQkFDbkUsZ0VBQWdFO2FBQ3pFO1NBQ0YsQ0FDRixDQUFDO1FBRUYsdUNBQXVDO1FBQ3ZDLGdFQUFnRTtRQUNoRSx5QkFBZSxDQUFDLDZCQUE2QixDQUMzQyxJQUFJLEVBQ0oscUNBQXFDLEVBQ3JDO1lBQ0U7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUFFLDRFQUE0RTtvQkFDNUUscURBQXFEO29CQUNyRCwwRkFBMEY7YUFDbkc7U0FDRixDQUNGLENBQUM7SUFDSixDQUFDO0NBQ0Y7QUE3UkQsd0NBNlJDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGVjMiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWMyJztcbmltcG9ydCAqIGFzIGVjcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNzJztcbmltcG9ydCAqIGFzIGVsYnYyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljbG9hZGJhbGFuY2luZ3YyJztcbmltcG9ydCAqIGFzIGVjciBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNyJztcbmltcG9ydCAqIGFzIGNvZ25pdG8gZnJvbSAnYXdzLWNkay1saWIvYXdzLWNvZ25pdG8nO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgYXBpZ2F0ZXdheSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheSc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7IE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gJ2Nkay1uYWcnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFNjYVdlYkFwcFN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIHZwYzogZWMyLklWcGM7XG4gIGNvZ25pdG9Vc2VyUG9vbDogY29nbml0by5JVXNlclBvb2w7XG4gIGNvZ25pdG9Vc2VyUG9vbENsaWVudDogY29nbml0by5JVXNlclBvb2xDbGllbnQ7XG4gIGRhdGFSZXRyaWV2YWxBcGk6IGFwaWdhdGV3YXkuSVJlc3RBcGk7XG4gIGFwaUdhdGV3YXlWcGNFbmRwb2ludDogZWMyLklJbnRlcmZhY2VWcGNFbmRwb2ludDtcbiAgZWNyUmVwb3NpdG9yeTogZWNyLklSZXBvc2l0b3J5O1xufVxuXG4vKipcbiAqIFNjYVdlYkFwcFN0YWNrIC0gV2ViIGFwcGxpY2F0aW9uIGluZnJhc3RydWN0dXJlIGZvciB0aGUgU0NBIHNvbHV0aW9uXG4gKiBcbiAqIFRoaXMgc3RhY2sgY29udGFpbnM6XG4gKiAtIEVDUyBjbHVzdGVyIGFuZCBGYXJnYXRlIHNlcnZpY2VcbiAqIC0gQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlciAocHJpdmF0ZSlcbiAqIC0gQXV0by1zY2FsaW5nIGNvbmZpZ3VyYXRpb25cbiAqIFxuICogUHJlcmVxdWlzaXRlczpcbiAqIC0gRUNSIHJlcG9zaXRvcnkgbXVzdCBleGlzdCAoY3JlYXRlZCBieSBTY2FFY3JTdGFjaylcbiAqIC0gRG9ja2VyIGltYWdlIG11c3QgYmUgcHVzaGVkIHRvIEVDUiBiZWZvcmUgZGVwbG95aW5nIHRoaXMgc3RhY2tcbiAqIFxuICogUmVzb3VyY2VzIGFyZSBleHBvc2VkIHZpYSBwdWJsaWMgcmVhZG9ubHkgcHJvcGVydGllcyBmb3IgdXNlIGJ5IG90aGVyIHN0YWNrcy5cbiAqIE5PIENsb3VkRm9ybWF0aW9uIGV4cG9ydHMgYXJlIHVzZWQgdG8gYXZvaWQgY3Jvc3Mtc3RhY2sgZGVwZW5kZW5jaWVzLlxuICovXG5leHBvcnQgY2xhc3MgU2NhV2ViQXBwU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgZWNzQ2x1c3RlcjogZWNzLkNsdXN0ZXI7XG4gIHB1YmxpYyByZWFkb25seSBhbGI6IGVsYnYyLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyO1xuICBwdWJsaWMgcmVhZG9ubHkgYWxiU2VjdXJpdHlHcm91cDogZWMyLlNlY3VyaXR5R3JvdXA7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IFNjYVdlYkFwcFN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIEVDUiBSZXBvc2l0b3J5IGZvciB3ZWIgYXBwbGljYXRpb24gaW1hZ2VzXG4gICAgdGhpcy5lY3NDbHVzdGVyID0gbmV3IGVjcy5DbHVzdGVyKHRoaXMsICdFY3NDbHVzdGVyJywge1xuICAgICAgY2x1c3Rlck5hbWU6ICdzY2EtY2x1c3RlcicsXG4gICAgICB2cGM6IHByb3BzLnZwYyxcbiAgICAgIGNvbnRhaW5lckluc2lnaHRzOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gU2VjdXJpdHkgZ3JvdXAgZm9yIEFMQlxuICAgIHRoaXMuYWxiU2VjdXJpdHlHcm91cCA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnQWxiU2VjdXJpdHlHcm91cCcsIHtcbiAgICAgIHZwYzogcHJvcHMudnBjLFxuICAgICAgZGVzY3JpcHRpb246ICdTZWN1cml0eSBncm91cCBmb3IgU0NBIEFwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXInLFxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIFByaXZhdGUgQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlciAoaW4gaXNvbGF0ZWQgc3VibmV0cylcbiAgICB0aGlzLmFsYiA9IG5ldyBlbGJ2Mi5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlcih0aGlzLCAnUHJpdmF0ZUFsYicsIHtcbiAgICAgIHZwYzogcHJvcHMudnBjLFxuICAgICAgaW50ZXJuZXRGYWNpbmc6IGZhbHNlLFxuICAgICAgc2VjdXJpdHlHcm91cDogdGhpcy5hbGJTZWN1cml0eUdyb3VwLFxuICAgICAgdnBjU3VibmV0czoge1xuICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX0lTT0xBVEVELFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBcbiAgICAvLyBMb2NrIGxvZ2ljYWwgSUQgdG8gcHJldmVudCBicmVha2luZyBjaGFuZ2VzXG4gICAgKHRoaXMuYWxiLm5vZGUuZGVmYXVsdENoaWxkIGFzIGVsYnYyLkNmbkxvYWRCYWxhbmNlcikub3ZlcnJpZGVMb2dpY2FsSWQoJ1ByaXZhdGVBbGJGMDdBOTRENScpO1xuXG4gICAgLy8gU2VjdXJpdHkgZ3JvdXAgZm9yIEVDUyB0YXNrc1xuICAgIGNvbnN0IGVjc1NlY3VyaXR5R3JvdXAgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ0Vjc1NlY3VyaXR5R3JvdXAnLCB7XG4gICAgICB2cGM6IHByb3BzLnZwYyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU2VjdXJpdHkgZ3JvdXAgZm9yIFNDQSBFQ1MgdGFza3MnLFxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIEFsbG93IEFMQiB0byBjb21tdW5pY2F0ZSB3aXRoIEVDUyB0YXNrc1xuICAgIGVjc1NlY3VyaXR5R3JvdXAuYWRkSW5ncmVzc1J1bGUoXG4gICAgICB0aGlzLmFsYlNlY3VyaXR5R3JvdXAsXG4gICAgICBlYzIuUG9ydC50Y3AoMzAwMCksXG4gICAgICAnQWxsb3cgQUxCIHRvIHJlYWNoIEVDUyB0YXNrcydcbiAgICApO1xuXG4gICAgLy8gSUFNIHJvbGUgZm9yIEVDUyB0YXNrIGV4ZWN1dGlvbiAocHVsbCBpbWFnZXMsIHdyaXRlIGxvZ3MpXG4gICAgY29uc3QgdGFza0V4ZWN1dGlvblJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ0Vjc1Rhc2tFeGVjdXRpb25Sb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdzZXJ2aWNlLXJvbGUvQW1hem9uRUNTVGFza0V4ZWN1dGlvblJvbGVQb2xpY3knKSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICAvLyBHcmFudCBFQ1IgcHVsbCBwZXJtaXNzaW9uc1xuICAgIHByb3BzLmVjclJlcG9zaXRvcnkuZ3JhbnRQdWxsKHRhc2tFeGVjdXRpb25Sb2xlKTtcblxuICAgIC8vIElBTSByb2xlIGZvciBFQ1MgdGFzayAoYXBwbGljYXRpb24gcGVybWlzc2lvbnMpXG4gICAgY29uc3QgdGFza1JvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ0Vjc1Rhc2tSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG5cbiAgICAvLyBFQ1MgVGFzayBEZWZpbml0aW9uXG4gICAgY29uc3QgdXNlQXJtID0gdGhpcy5ub2RlLnRyeUdldENvbnRleHQoJ2FybScpID09PSB0cnVlIHx8IHRoaXMubm9kZS50cnlHZXRDb250ZXh0KCdhcm0nKSA9PT0gJ3RydWUnO1xuXG4gICAgY29uc3QgdGFza0RlZmluaXRpb24gPSBuZXcgZWNzLkZhcmdhdGVUYXNrRGVmaW5pdGlvbih0aGlzLCAnV2ViQXBwVGFza0RlZmluaXRpb24nLCB7XG4gICAgICBmYW1pbHk6ICdzY2Etd2ViLWFwcCcsXG4gICAgICBjcHU6IDI1NixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiA1MTIsXG4gICAgICBleGVjdXRpb25Sb2xlOiB0YXNrRXhlY3V0aW9uUm9sZSxcbiAgICAgIHRhc2tSb2xlOiB0YXNrUm9sZSxcbiAgICAgIC4uLih1c2VBcm0gJiYge1xuICAgICAgICBydW50aW1lUGxhdGZvcm06IHtcbiAgICAgICAgICBjcHVBcmNoaXRlY3R1cmU6IGVjcy5DcHVBcmNoaXRlY3R1cmUuQVJNNjQsXG4gICAgICAgICAgb3BlcmF0aW5nU3lzdGVtRmFtaWx5OiBlY3MuT3BlcmF0aW5nU3lzdGVtRmFtaWx5LkxJTlVYLFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgY29udGFpbmVyIHRvIHRhc2sgZGVmaW5pdGlvblxuICAgIGNvbnN0IGNvbnRhaW5lciA9IHRhc2tEZWZpbml0aW9uLmFkZENvbnRhaW5lcignV2ViQXBwQ29udGFpbmVyJywge1xuICAgICAgY29udGFpbmVyTmFtZTogJ3NjYS13ZWItYXBwJyxcbiAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbUVjclJlcG9zaXRvcnkocHJvcHMuZWNyUmVwb3NpdG9yeSwgJ2xhdGVzdCcpLFxuICAgICAgbG9nZ2luZzogZWNzLkxvZ0RyaXZlcnMuYXdzTG9ncyh7XG4gICAgICAgIHN0cmVhbVByZWZpeDogJ3NjYS13ZWItYXBwJyxcbiAgICAgICAgbG9nUmV0ZW50aW9uOiA3LFxuICAgICAgfSksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICAvLyBSZWFjdCBidWlsZC10aW1lIGVudmlyb25tZW50IHZhcmlhYmxlc1xuICAgICAgICBSRUFDVF9BUFBfVVNFUl9QT09MX0lEOiBwcm9wcy5jb2duaXRvVXNlclBvb2wudXNlclBvb2xJZCxcbiAgICAgICAgUkVBQ1RfQVBQX1VTRVJfUE9PTF9DTElFTlRfSUQ6IHByb3BzLmNvZ25pdG9Vc2VyUG9vbENsaWVudC51c2VyUG9vbENsaWVudElkLFxuICAgICAgICBSRUFDVF9BUFBfQVBJX0VORFBPSU5UOiBgaHR0cHM6Ly8ke3Byb3BzLmRhdGFSZXRyaWV2YWxBcGkucmVzdEFwaUlkfS5leGVjdXRlLWFwaS4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tL3Byb2QvYCxcbiAgICAgICAgUkVBQ1RfQVBQX0FXU19SRUdJT046IHRoaXMucmVnaW9uLFxuICAgICAgICAvLyBOZ2lueCBydW50aW1lIGVudmlyb25tZW50IHZhcmlhYmxlcyBmb3IgQVBJIHByb3h5XG4gICAgICAgIEFQSV9FTkRQT0lOVDogYGh0dHBzOi8vJHtwcm9wcy5kYXRhUmV0cmlldmFsQXBpLnJlc3RBcGlJZH0tJHtwcm9wcy5hcGlHYXRld2F5VnBjRW5kcG9pbnQudnBjRW5kcG9pbnRJZH0uZXhlY3V0ZS1hcGkuJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbS9wcm9kL2AsXG4gICAgICAgIEFQSV9IT1NUOiBgJHtwcm9wcy5kYXRhUmV0cmlldmFsQXBpLnJlc3RBcGlJZH0tJHtwcm9wcy5hcGlHYXRld2F5VnBjRW5kcG9pbnQudnBjRW5kcG9pbnRJZH0uZXhlY3V0ZS1hcGkuJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbWAsXG4gICAgICAgIC8vIERlcGxveSB0aW1lc3RhbXAgZm9yY2VzIGEgbmV3IHRhc2sgZGVmaW5pdGlvbiByZXZpc2lvbiBvbiBlYWNoIGRlcGxveSxcbiAgICAgICAgLy8gZW5zdXJpbmcgRUNTIHB1bGxzIHRoZSBsYXRlc3QgaW1hZ2UgZnJvbSBFQ1JcbiAgICAgICAgREVQTE9ZX1RJTUVTVEFNUDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgfSxcbiAgICAgIGhlYWx0aENoZWNrOiB7XG4gICAgICAgIGNvbW1hbmQ6IFsnQ01ELVNIRUxMJywgJ2N1cmwgLWYgaHR0cDovL2xvY2FsaG9zdDozMDAwL2hlYWx0aCB8fCBleGl0IDEnXSxcbiAgICAgICAgaW50ZXJ2YWw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNSksXG4gICAgICAgIHJldHJpZXM6IDMsXG4gICAgICAgIHN0YXJ0UGVyaW9kOiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MCksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHBvcnQgbWFwcGluZ1xuICAgIGNvbnRhaW5lci5hZGRQb3J0TWFwcGluZ3Moe1xuICAgICAgY29udGFpbmVyUG9ydDogMzAwMCxcbiAgICAgIHByb3RvY29sOiBlY3MuUHJvdG9jb2wuVENQLFxuICAgIH0pO1xuXG4gICAgLy8gRUNTIFNlcnZpY2VcbiAgICBjb25zdCBlY3NTZXJ2aWNlID0gbmV3IGVjcy5GYXJnYXRlU2VydmljZSh0aGlzLCAnV2ViQXBwU2VydmljZScsIHtcbiAgICAgIHNlcnZpY2VOYW1lOiAnc2NhLXdlYi1hcHAtc2VydmljZScsXG4gICAgICBjbHVzdGVyOiB0aGlzLmVjc0NsdXN0ZXIsXG4gICAgICB0YXNrRGVmaW5pdGlvbjogdGFza0RlZmluaXRpb24sXG4gICAgICBkZXNpcmVkQ291bnQ6IDIsXG4gICAgICBtaW5IZWFsdGh5UGVyY2VudDogNTAsXG4gICAgICBtYXhIZWFsdGh5UGVyY2VudDogMjAwLFxuICAgICAgc2VjdXJpdHlHcm91cHM6IFtlY3NTZWN1cml0eUdyb3VwXSxcbiAgICAgIHZwY1N1Ym5ldHM6IHtcbiAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9JU09MQVRFRCxcbiAgICAgIH0sXG4gICAgICBlbmFibGVFeGVjdXRlQ29tbWFuZDogdHJ1ZSxcbiAgICAgIGNpcmN1aXRCcmVha2VyOiB7XG4gICAgICAgIHJvbGxiYWNrOiB0cnVlLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEFMQiBUYXJnZXQgR3JvdXAgZm9yIEVDUyBTZXJ2aWNlXG4gICAgY29uc3QgdGFyZ2V0R3JvdXAgPSBuZXcgZWxidjIuQXBwbGljYXRpb25UYXJnZXRHcm91cCh0aGlzLCAnV2ViQXBwVGFyZ2V0R3JvdXAnLCB7XG4gICAgICB2cGM6IHByb3BzLnZwYyxcbiAgICAgIHBvcnQ6IDMwMDAsXG4gICAgICBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgdGFyZ2V0VHlwZTogZWxidjIuVGFyZ2V0VHlwZS5JUCxcbiAgICAgIGhlYWx0aENoZWNrOiB7XG4gICAgICAgIHBhdGg6ICcvaGVhbHRoJyxcbiAgICAgICAgaW50ZXJ2YWw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNSksXG4gICAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogMixcbiAgICAgICAgdW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IDMsXG4gICAgICAgIGhlYWx0aHlIdHRwQ29kZXM6ICcyMDAnLFxuICAgICAgfSxcbiAgICAgIGRlcmVnaXN0cmF0aW9uRGVsYXk6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICB9KTtcblxuICAgIC8vIFJlZ2lzdGVyIEVDUyBzZXJ2aWNlIHdpdGggdGFyZ2V0IGdyb3VwXG4gICAgZWNzU2VydmljZS5hdHRhY2hUb0FwcGxpY2F0aW9uVGFyZ2V0R3JvdXAodGFyZ2V0R3JvdXApO1xuXG4gICAgLy8gQUxCIExpc3RlbmVyIChIVFRQIG9uIHBvcnQgODApXG4gICAgdGhpcy5hbGIuYWRkTGlzdGVuZXIoJ0h0dHBMaXN0ZW5lcicsIHtcbiAgICAgIHBvcnQ6IDgwLFxuICAgICAgcHJvdG9jb2w6IGVsYnYyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICAgIGRlZmF1bHRBY3Rpb246IGVsYnYyLkxpc3RlbmVyQWN0aW9uLmZvcndhcmQoW3RhcmdldEdyb3VwXSksXG4gICAgICBvcGVuOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIC8vIEF1dG8tc2NhbGluZyBjb25maWd1cmF0aW9uXG4gICAgY29uc3Qgc2NhbGluZyA9IGVjc1NlcnZpY2UuYXV0b1NjYWxlVGFza0NvdW50KHtcbiAgICAgIG1pbkNhcGFjaXR5OiAyLFxuICAgICAgbWF4Q2FwYWNpdHk6IDEwLFxuICAgIH0pO1xuXG4gICAgLy8gU2NhbGUgYmFzZWQgb24gQ1BVIHV0aWxpemF0aW9uXG4gICAgc2NhbGluZy5zY2FsZU9uQ3B1VXRpbGl6YXRpb24oJ0NwdVNjYWxpbmcnLCB7XG4gICAgICB0YXJnZXRVdGlsaXphdGlvblBlcmNlbnQ6IDcwLFxuICAgICAgc2NhbGVJbkNvb2xkb3duOiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MCksXG4gICAgICBzY2FsZU91dENvb2xkb3duOiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MCksXG4gICAgfSk7XG5cbiAgICAvLyBTY2FsZSBiYXNlZCBvbiBtZW1vcnkgdXRpbGl6YXRpb25cbiAgICBzY2FsaW5nLnNjYWxlT25NZW1vcnlVdGlsaXphdGlvbignTWVtb3J5U2NhbGluZycsIHtcbiAgICAgIHRhcmdldFV0aWxpemF0aW9uUGVyY2VudDogODAsXG4gICAgICBzY2FsZUluQ29vbGRvd246IGNkay5EdXJhdGlvbi5zZWNvbmRzKDYwKSxcbiAgICAgIHNjYWxlT3V0Q29vbGRvd246IGNkay5EdXJhdGlvbi5zZWNvbmRzKDYwKSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDbG91ZEZvcm1hdGlvbiBPdXRwdXRzIChOTyBFWFBPUlRTKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQWxiRG5zTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmFsYi5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdQcml2YXRlIEFMQiBETlMgbmFtZScsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQWxiU2VjdXJpdHlHcm91cElkJywge1xuICAgICAgdmFsdWU6IHRoaXMuYWxiU2VjdXJpdHlHcm91cC5zZWN1cml0eUdyb3VwSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FMQiBTZWN1cml0eSBHcm91cCBJRCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRWNzQ2x1c3Rlck5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5lY3NDbHVzdGVyLmNsdXN0ZXJOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1MgQ2x1c3RlciBuYW1lJyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDREsgTmFnIFN1cHByZXNzaW9uc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIFN1cHByZXNzIHdpbGRjYXJkIHBlcm1pc3Npb25zIGZvciBFQ1MgVGFzayBFeGVjdXRpb24gUm9sZVxuICAgIC8vIEVDUyB0YXNrcyByZXF1aXJlIHdpbGRjYXJkIHBlcm1pc3Npb25zIGZvciBFQ1IgYW5kIENsb3VkV2F0Y2ggTG9nc1xuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9uc0J5UGF0aChcbiAgICAgIHRoaXMsXG4gICAgICAnL1NjYVdlYkFwcFN0YWNrL0Vjc1Rhc2tFeGVjdXRpb25Sb2xlL0RlZmF1bHRQb2xpY3kvUmVzb3VyY2UnLFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgICAgcmVhc29uOiAnRUNTIFRhc2sgRXhlY3V0aW9uIFJvbGUgcmVxdWlyZXMgd2lsZGNhcmQgcGVybWlzc2lvbnMgZm9yOiAnICtcbiAgICAgICAgICAgICAgICAgICcxKSBFQ1IgaW1hZ2UgcHVsbCAoZWNyOkdldEF1dGhvcml6YXRpb25Ub2tlbiByZXF1aXJlcyBSZXNvdXJjZTogXCIqXCIpICcgK1xuICAgICAgICAgICAgICAgICAgJzIpIENsb3VkV2F0Y2ggTG9ncyAobG9nczpDcmVhdGVMb2dTdHJlYW0gYW5kIGxvZ3M6UHV0TG9nRXZlbnRzIHJlcXVpcmUgd2lsZGNhcmQgZm9yIHJ1bnRpbWUgbG9nIGdyb3VwIGNyZWF0aW9uKSAnICtcbiAgICAgICAgICAgICAgICAgICdTZWU6IGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9BbWF6b25FQ1MvbGF0ZXN0L2RldmVsb3Blcmd1aWRlL3Rhc2tfZXhlY3V0aW9uX0lBTV9yb2xlLmh0bWwnLFxuICAgICAgICAgIGFwcGxpZXNUbzogWydSZXNvdXJjZTo6KiddLFxuICAgICAgICB9LFxuICAgICAgXVxuICAgICk7XG5cbiAgICAvLyBTdXBwcmVzcyB3aWxkY2FyZCBwZXJtaXNzaW9ucyBmb3IgRUNTIFRhc2sgUm9sZVxuICAgIC8vIFRhc2sgcm9sZSBuZWVkcyB3aWxkY2FyZCBmb3IgQ2xvdWRXYXRjaCBMb2dzIGFuZCBYLVJheSB0cmFjaW5nXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zQnlQYXRoKFxuICAgICAgdGhpcyxcbiAgICAgICcvU2NhV2ViQXBwU3RhY2svRWNzVGFza1JvbGUvRGVmYXVsdFBvbGljeS9SZXNvdXJjZScsXG4gICAgICBbXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JyxcbiAgICAgICAgICByZWFzb246ICdFQ1MgVGFzayBSb2xlIHJlcXVpcmVzIHdpbGRjYXJkIHBlcm1pc3Npb25zIGZvciBDbG91ZFdhdGNoIExvZ3MgYW5kIFgtUmF5IHRyYWNpbmcuICcgK1xuICAgICAgICAgICAgICAgICAgJ1RoZXNlIHNlcnZpY2VzIHJlcXVpcmUgUmVzb3VyY2U6IFwiKlwiIGZvciBydW50aW1lIGxvZyBncm91cCBhbmQgdHJhY2Ugc2VnbWVudCBjcmVhdGlvbi4nLFxuICAgICAgICAgIGFwcGxpZXNUbzogWydSZXNvdXJjZTo6KiddLFxuICAgICAgICB9LFxuICAgICAgXVxuICAgICk7XG5cbiAgICAvLyBTdXBwcmVzcyBBV1MgbWFuYWdlZCBwb2xpY3kgZm9yIEVDUyBUYXNrIEV4ZWN1dGlvblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9uc0J5UGF0aChcbiAgICAgIHRoaXMsXG4gICAgICAnL1NjYVdlYkFwcFN0YWNrL0Vjc1Rhc2tFeGVjdXRpb25Sb2xlL1Jlc291cmNlJyxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTQnLFxuICAgICAgICAgIHJlYXNvbjogJ0FtYXpvbkVDU1Rhc2tFeGVjdXRpb25Sb2xlUG9saWN5IGlzIHRoZSBBV1MgcmVjb21tZW5kZWQgbWFuYWdlZCBwb2xpY3kgZm9yIEVDUyB0YXNrIGV4ZWN1dGlvbi4gJyArXG4gICAgICAgICAgICAgICAgICAnSXQgcHJvdmlkZXMgbmVjZXNzYXJ5IHBlcm1pc3Npb25zIGZvciBFQ1IgaW1hZ2UgcHVsbCBhbmQgQ2xvdWRXYXRjaCBMb2dzLiAnICtcbiAgICAgICAgICAgICAgICAgICdTZWU6IGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9BbWF6b25FQ1MvbGF0ZXN0L2RldmVsb3Blcmd1aWRlL3Rhc2tfZXhlY3V0aW9uX0lBTV9yb2xlLmh0bWwnLFxuICAgICAgICAgIGFwcGxpZXNUbzogWydQb2xpY3k6OmFybjo8QVdTOjpQYXJ0aXRpb24+OmlhbTo6YXdzOnBvbGljeS9zZXJ2aWNlLXJvbGUvQW1hem9uRUNTVGFza0V4ZWN1dGlvblJvbGVQb2xpY3knXSxcbiAgICAgICAgfSxcbiAgICAgIF1cbiAgICApO1xuXG4gICAgLy8gU3VwcHJlc3MgRUNTIGVudmlyb25tZW50IHZhcmlhYmxlcyB3YXJuaW5nXG4gICAgLy8gVGhlIGVudmlyb25tZW50IHZhcmlhYmxlcyBjb250YWluIG5vbi1zZW5zaXRpdmUgY29uZmlndXJhdGlvbiAoQ29nbml0byBJRHMsIEFQSSBlbmRwb2ludHMpXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zQnlQYXRoKFxuICAgICAgdGhpcyxcbiAgICAgICcvU2NhV2ViQXBwU3RhY2svV2ViQXBwVGFza0RlZmluaXRpb24vUmVzb3VyY2UnLFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtRUNTMicsXG4gICAgICAgICAgcmVhc29uOiAnRW52aXJvbm1lbnQgdmFyaWFibGVzIGNvbnRhaW4gbm9uLXNlbnNpdGl2ZSBjb25maWd1cmF0aW9uIGRhdGE6ICcgK1xuICAgICAgICAgICAgICAgICAgJ0NvZ25pdG8gVXNlciBQb29sIElELCBDbGllbnQgSUQsIEFXUyBSZWdpb24sIGFuZCBBUEkgZW5kcG9pbnRzLiAnICtcbiAgICAgICAgICAgICAgICAgICdUaGVzZSBhcmUgcHVibGljIGlkZW50aWZpZXJzIGFuZCBkbyBub3QgcmVxdWlyZSBTZWNyZXRzIE1hbmFnZXIuICcgK1xuICAgICAgICAgICAgICAgICAgJ1NlbnNpdGl2ZSBkYXRhIGxpa2UgY3JlZGVudGlhbHMgYXJlIG1hbmFnZWQgdGhyb3VnaCBJQU0gcm9sZXMuJyxcbiAgICAgICAgfSxcbiAgICAgIF1cbiAgICApO1xuXG4gICAgLy8gU3VwcHJlc3MgQUxCIGFjY2VzcyBsb2dzIHJlcXVpcmVtZW50XG4gICAgLy8gQWNjZXNzIGxvZ3MgYWRkIG9wZXJhdGlvbmFsIG92ZXJoZWFkIGFuZCBjb3N0IGZvciBwcml2YXRlIEFMQlxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9uc0J5UGF0aChcbiAgICAgIHRoaXMsXG4gICAgICAnL1NjYVdlYkFwcFN0YWNrL1ByaXZhdGVBbGIvUmVzb3VyY2UnLFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtRUxCMicsXG4gICAgICAgICAgcmVhc29uOiAnQUxCIGFjY2VzcyBsb2dzIGFyZSBub3QgZW5hYmxlZCB0byByZWR1Y2Ugb3BlcmF0aW9uYWwgb3ZlcmhlYWQgYW5kIGNvc3RzLiAnICtcbiAgICAgICAgICAgICAgICAgICdUaGlzIGlzIGEgcHJpdmF0ZSBBTEIgbm90IGV4cG9zZWQgdG8gdGhlIGludGVybmV0LiAnICtcbiAgICAgICAgICAgICAgICAgICdGb3IgcHJvZHVjdGlvbiBkZXBsb3ltZW50cywgZW5hYmxlIGFjY2VzcyBsb2dzIGZvciB0cmFmZmljIGFuYWx5c2lzIGFuZCB0cm91Ymxlc2hvb3RpbmcuJyxcbiAgICAgICAgfSxcbiAgICAgIF1cbiAgICApO1xuICB9XG59XG4iXX0=