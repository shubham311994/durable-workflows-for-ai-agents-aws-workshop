import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';
export interface ScaCloudFrontAccessStackProps extends cdk.StackProps {
    vpc: ec2.Vpc;
    alb: elbv2.IApplicationLoadBalancer;
}
export declare class ScaCloudFrontAccessStack extends cdk.Stack {
    readonly internetGateway: ec2.CfnInternetGateway;
    readonly cloudFrontDistribution: cloudfront.Distribution;
    readonly publicSubnets: any[];
    readonly natGateway: ec2.CfnNatGateway;
    constructor(scope: Construct, id: string, props: ScaCloudFrontAccessStackProps);
}
