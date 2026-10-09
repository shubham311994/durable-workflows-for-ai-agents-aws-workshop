import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
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
export declare class ScaConnectStack extends cdk.Stack {
    readonly connectInstance: connect.CfnInstance;
    readonly phoneNumber: connect.CfnPhoneNumber;
    readonly adminCredentials: secretsmanager.ISecret;
    constructor(scope: Construct, id: string, props: ScaConnectStackProps);
}
