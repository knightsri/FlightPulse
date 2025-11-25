import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface NetworkConstructProps {
    /**
     * CIDR block for the VPC
     * @default '10.0.0.0/16'
     */
    readonly cidr?: string;

    /**
     * Maximum number of Availability Zones to use
     * @default 2
     */
    readonly maxAzs?: number;

    /**
     * Whether to create VPC endpoints for AWS services
     * @default true
     */
    readonly createVpcEndpoints?: boolean;
}

/**
 * Network construct that creates a VPC with private subnets and VPC endpoints
 * for secure Lambda execution without internet access.
 */
export class NetworkConstruct extends Construct {
    public readonly vpc: ec2.Vpc;
    public readonly lambdaSecurityGroup: ec2.SecurityGroup;

    constructor(scope: Construct, id: string, props?: NetworkConstructProps) {
        super(scope, id);

        // Create VPC with private subnets only (no NAT gateways for cost optimization)
        this.vpc = new ec2.Vpc(this, 'FlightPulseVpc', {
            ipAddresses: ec2.IpAddresses.cidr(props?.cidr || '10.0.0.0/16'),
            maxAzs: props?.maxAzs || 2,
            natGateways: 0, // No NAT gateway - use VPC endpoints instead
            subnetConfiguration: [
                {
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 24,
                },
            ],
            enableDnsHostnames: true,
            enableDnsSupport: true,
        });

        // Security group for Lambda functions
        this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
            vpc: this.vpc,
            description: 'Security group for FlightPulse Lambda functions',
            allowAllOutbound: true, // Required for VPC endpoint access
        });

        // Create VPC endpoints if enabled
        if (props?.createVpcEndpoints !== false) {
            this.createVpcEndpoints();
        }

        // Tag all resources
        cdk.Tags.of(this).add('Component', 'Network');
    }

    private createVpcEndpoints(): void {
        // DynamoDB Gateway Endpoint (free)
        this.vpc.addGatewayEndpoint('DynamoDBEndpoint', {
            service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
        });

        // S3 Gateway Endpoint (free) - needed for Lambda deployment packages
        this.vpc.addGatewayEndpoint('S3Endpoint', {
            service: ec2.GatewayVpcEndpointAwsService.S3,
        });

        // Lambda Interface Endpoint - for Lambda invocations
        this.vpc.addInterfaceEndpoint('LambdaEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.LAMBDA,
            securityGroups: [this.lambdaSecurityGroup],
        });

        // EventBridge Interface Endpoint
        this.vpc.addInterfaceEndpoint('EventBridgeEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.EVENTBRIDGE,
            securityGroups: [this.lambdaSecurityGroup],
        });

        // SQS Interface Endpoint - for DLQ
        this.vpc.addInterfaceEndpoint('SqsEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.SQS,
            securityGroups: [this.lambdaSecurityGroup],
        });

        // Step Functions Interface Endpoint
        this.vpc.addInterfaceEndpoint('StepFunctionsEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.STEP_FUNCTIONS,
            securityGroups: [this.lambdaSecurityGroup],
        });

        // CloudWatch Logs Interface Endpoint - for Lambda logging
        this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
            securityGroups: [this.lambdaSecurityGroup],
        });

        // Bedrock Runtime Interface Endpoint - for LLM calls
        // Note: Bedrock endpoints may not be available in all regions
        try {
            this.vpc.addInterfaceEndpoint('BedrockRuntimeEndpoint', {
                service: new ec2.InterfaceVpcEndpointService(
                    `com.amazonaws.${cdk.Stack.of(this).region}.bedrock-runtime`,
                    443
                ),
                securityGroups: [this.lambdaSecurityGroup],
            });
        } catch (error) {
            // Bedrock endpoint may not be available in this region
            console.warn('Bedrock VPC endpoint not created - may not be available in this region');
        }

        // SSM Interface Endpoint - for Parameter Store access
        this.vpc.addInterfaceEndpoint('SsmEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.SSM,
            securityGroups: [this.lambdaSecurityGroup],
        });
    }
}
