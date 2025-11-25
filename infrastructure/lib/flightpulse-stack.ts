import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import * as path from 'path';
import { NetworkConstruct } from './network-construct';
import { MonitoringConstruct } from './monitoring-construct';
import { FlightPulseConstants } from './constants';

export class FlightPulseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Get removal policy from context (defaults to RETAIN for production safety)
    const removalPolicy = this.node.tryGetContext('removalPolicy') === 'destroy'
      ? cdk.RemovalPolicy.DESTROY
      : cdk.RemovalPolicy.RETAIN;

    // Get environment from context (defaults to 'dev')
    const environment = this.node.tryGetContext('environment') || 'dev';

    // Create VPC and network infrastructure
    const network = new NetworkConstruct(this, 'Network', {
      cidr: '10.0.0.0/16',
      maxAzs: 2,
      createVpcEndpoints: true,
    });

    // Store Bedrock model ID in SSM Parameter Store (SecureString)
    // Store Bedrock model ID in SSM Parameter Store (SecureString)
    const bedrockModelParam = new ssm.StringParameter(this, 'BedrockModelId', {
      parameterName: FlightPulseConstants.BEDROCK_MODEL_PARAM_NAME,
      stringValue: FlightPulseConstants.BEDROCK_MODEL_ID,
      description: 'Bedrock model ID for LLM messenger Lambda',
      tier: ssm.ParameterTier.STANDARD,
    });

    // DynamoDB Table - Single Table Design
    const table = new dynamodb.Table(this, 'FlightPulseTable', {

      tableName: FlightPulseConstants.TABLE_NAME,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: removalPolicy, // Configurable via cdk.json context
    });

    // GSI1: Status-based queries
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
    });

    // GSI2: Booking status queries
    table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
    });

    // EventBridge Bus
    const eventBus = new events.EventBus(this, 'FlightPulseBus', {
      eventBusName: FlightPulseConstants.EVENT_BUS_NAME,
    });

    // Dead Letter Queue for Step Functions failures
    const dlq = new sqs.Queue(this, 'WorkflowDLQ', {
      retentionPeriod: cdk.Duration.days(14),
    });

    // SNS Topic for error notifications
    const errorTopic = new sns.Topic(this, 'WorkflowErrorTopic', {
      displayName: 'FlightPulse Workflow Errors',
      topicName: FlightPulseConstants.WORKFLOW_ERROR_TOPIC_NAME,
    });

    // Kafka Consumer Lambda (Python)
    const kafkaConsumer = new lambda.Function(this, 'KafkaConsumer', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambdas/python/kafka-consumer')),
      environment: {
        TABLE_NAME: table.tableName,
        EVENT_BUS_NAME: eventBus.eventBusName,
      },
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_WEEK,
      vpc: network.vpc,
      vpcSubnets: { subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [network.lambdaSecurityGroup],
    });

    table.grantReadWriteData(kafkaConsumer);
    eventBus.grantPutEventsTo(kafkaConsumer);

    // LLM Messenger Lambda (Python)
    const llmMessenger = new lambda.Function(this, 'LLMMessenger', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambdas/python/llm-messenger')),
      environment: {
        TABLE_NAME: table.tableName,
        BEDROCK_MODEL_PARAM: bedrockModelParam.parameterName, // Reference to SSM parameter
      },
      timeout: cdk.Duration.seconds(120), // Increased for LLM processing
      memorySize: 512,
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_WEEK,
      vpc: network.vpc,
      vpcSubnets: { subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [network.lambdaSecurityGroup],
    });
    llmMessenger.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/${FlightPulseConstants.BEDROCK_MODEL_ID}`
      ],
    }));
    table.grantReadData(llmMessenger);
    bedrockModelParam.grantRead(llmMessenger); // Grant read access to SSM parameter

    // API Handlers Lambda (Node.js)
    const apiHandlers = new lambda.Function(this, 'ApiHandlers', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../../lambdas/nodejs/api-handlers'),
        this.getNodeJsBundlingOptions()
      ),
      environment: {
        TABLE_NAME: table.tableName,
      },
      timeout: cdk.Duration.seconds(10),
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_WEEK,
      vpc: network.vpc,
      vpcSubnets: { subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [network.lambdaSecurityGroup],
    });

    table.grantReadData(apiHandlers);

    // Stream Handler Lambda (Node.js)
    const streamHandler = new lambda.Function(this, 'StreamHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../../lambdas/nodejs/stream-handler'),
        this.getNodeJsBundlingOptions()
      ),
      environment: {
        EVENT_BUS_NAME: eventBus.eventBusName,
      },
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_WEEK,
      vpc: network.vpc,
      vpcSubnets: { subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [network.lambdaSecurityGroup],
    });

    eventBus.grantPutEventsTo(streamHandler);

    // DynamoDB Stream → Stream Handler
    streamHandler.addEventSourceMapping('StreamEventSource', {
      eventSourceArn: table.tableStreamArn!,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 10,
    });

    // Step Functions State Machines
    const delayWorkflow = this.createDelayWorkflow(this, table, llmMessenger, eventBus, dlq, errorTopic);
    const cancellationWorkflow = this.createCancellationWorkflow(this, table, llmMessenger, eventBus, dlq, errorTopic);
    const gateChangeWorkflow = this.createGateChangeWorkflow(this, table, llmMessenger, eventBus, dlq, errorTopic);

    // EventBridge Rules
    new events.Rule(this, 'DelayMinorRule', {
      eventBus,
      eventPattern: {
        source: ['flightpulse.kafka-consumer'],
        detailType: ['flight.delay.minor'],
      },
      targets: [new targets.SfnStateMachine(delayWorkflow)],
    });

    new events.Rule(this, 'DelayMajorRule', {
      eventBus,
      eventPattern: {
        source: ['flightpulse.kafka-consumer'],
        detailType: ['flight.delay.major'],
      },
      targets: [new targets.SfnStateMachine(delayWorkflow)],
    });

    new events.Rule(this, 'DelaySevereRule', {
      eventBus,
      eventPattern: {
        source: ['flightpulse.kafka-consumer'],
        detailType: ['flight.delay.severe'],
      },
      targets: [new targets.SfnStateMachine(delayWorkflow)],
    });

    new events.Rule(this, 'CancellationRule', {
      eventBus,
      eventPattern: {
        source: ['flightpulse.kafka-consumer'],
        detailType: ['flight.cancelled'],
      },
      targets: [new targets.SfnStateMachine(cancellationWorkflow)],
    });

    new events.Rule(this, 'GateChangeRule', {
      eventBus,
      eventPattern: {
        source: ['flightpulse.kafka-consumer'],
        detailType: ['flight.gate_change'],
      },
      targets: [new targets.SfnStateMachine(gateChangeWorkflow)],
    });

    // Notification rules (mock to CloudWatch)
    new events.Rule(this, 'NotificationEmailRule', {
      eventBus,
      eventPattern: {
        detailType: ['notification.email'],
      },
      targets: [new targets.CloudWatchLogGroup(
        new logs.LogGroup(this, 'EmailNotificationsLog', {
          logGroupName: FlightPulseConstants.LOG_GROUP_NAMES.EMAIL_NOTIFICATIONS,
          retention: logs.RetentionDays.ONE_WEEK,
        })
      )],
    });

    new events.Rule(this, 'NotificationSmsRule', {
      eventBus,
      eventPattern: {
        detailType: ['notification.sms'],
      },
      targets: [new targets.CloudWatchLogGroup(
        new logs.LogGroup(this, 'SmsNotificationsLog', {
          logGroupName: FlightPulseConstants.LOG_GROUP_NAMES.SMS_NOTIFICATIONS,
          retention: logs.RetentionDays.ONE_WEEK,
        })
      )],
    });

    // API Gateway Access Logs
    const apiAccessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: FlightPulseConstants.LOG_GROUP_NAMES.API_ACCESS,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // API Gateway
    const api = new apigateway.RestApi(this, 'FlightPulseApi', {
      restApiName: 'FlightPulse API',
      description: 'FlightPulse REST API',
      deployOptions: {
        accessLogDestination: new apigateway.LogGroupLogDestination(apiAccessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
      // Enable basic throttling to protect against abuse
      defaultMethodOptions: {
        apiKeyRequired: true, // Require API Key for all methods
      },
    });

    // Create API Key
    const apiKey = api.addApiKey('FlightPulseApiKey', {
      apiKeyName: 'flightpulse-api-key',
      description: 'API Key for FlightPulse client',
    });

    // Create Usage Plan
    const plan = api.addUsagePlan('FlightPulseUsagePlan', {
      name: 'flightpulse-usage-plan',
      throttle: {
        rateLimit: 100,
        burstLimit: 200,
      },
      quota: {
        limit: 10000,
        period: apigateway.Period.DAY,
      },
    });

    // Associate API Key and Stage with Usage Plan
    plan.addApiKey(apiKey);
    plan.addApiStage({
      stage: api.deploymentStage,
    });

    // Output API Key ID (Value is secret, so only ID is output)
    new cdk.CfnOutput(this, 'ApiKeyId', { value: apiKey.keyId });

    const apiIntegration = new apigateway.LambdaIntegration(apiHandlers);

    // Health check
    api.root.addResource('health').addMethod('GET', apiIntegration);

    // Flights endpoints
    const flights = api.root.addResource('flights');
    flights.addMethod('GET', apiIntegration);
    const flight = flights.addResource('{flightId}');
    flight.addMethod('GET', apiIntegration);
    flight.addResource('bookings').addMethod('GET', apiIntegration);

    // Passengers endpoints
    const passengers = api.root.addResource('passengers');
    const passenger = passengers.addResource('{passengerId}');
    passenger.addMethod('GET', apiIntegration);
    passenger.addResource('bookings').addMethod('GET', apiIntegration);

    // Bookings endpoints
    const bookings = api.root.addResource('bookings');
    bookings.addResource('{bookingId}').addMethod('GET', apiIntegration);

    // Monitoring & Alarms
    const monitoring = new MonitoringConstruct(this, 'Monitoring', {
      alarmEmail: this.node.tryGetContext('alarmEmail'),
      lambdaFunctions: [kafkaConsumer, llmMessenger, apiHandlers, streamHandler],
      table,
      stateMachines: [delayWorkflow, cancellationWorkflow, gateChangeWorkflow],
    });

    // Create CloudWatch Dashboard
    monitoring.createDashboard(
      [kafkaConsumer, llmMessenger, apiHandlers, streamHandler],
      table,
      [delayWorkflow, cancellationWorkflow, gateChangeWorkflow]
    );

    // Outputs
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'EventBusName', { value: eventBus.eventBusName });
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'ErrorTopicArn', { value: errorTopic.topicArn });
    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: monitoring.alarmTopic.topicArn });
    new cdk.CfnOutput(this, 'ApiAccessLogGroup', { value: apiAccessLogGroup.logGroupName });

    // Apply standard tags to all resources
    // Apply standard tags to all resources
    cdk.Tags.of(this).add(FlightPulseConstants.TAGS.PROJECT, FlightPulseConstants.PROJECT_NAME);
    cdk.Tags.of(this).add(FlightPulseConstants.TAGS.ENVIRONMENT, environment);
    cdk.Tags.of(this).add(FlightPulseConstants.TAGS.MANAGED_BY, 'CDK');
    cdk.Tags.of(this).add(FlightPulseConstants.TAGS.COST_CENTER, 'Engineering');
  }

  private createDelayWorkflow(
    scope: Construct,
    table: dynamodb.Table,
    llmMessenger: lambda.Function,
    eventBus: events.EventBus,
    dlq: sqs.Queue,
    errorTopic: sns.Topic
  ): sfn.StateMachine {
    // Failure notification state
    const notifyFailure = new sfnTasks.SnsPublish(scope, 'NotifyDelayFailure', {
      topic: errorTopic,
      message: sfn.TaskInput.fromObject({
        workflow: 'DelayNotification',
        error: sfn.JsonPath.stringAt('$.Error'),
        cause: sfn.JsonPath.stringAt('$.Cause'),
        input: sfn.JsonPath.entirePayload,
      }),
    });

    // GetAffectedBookings with error handling
    const getBookings = new sfnTasks.CallAwsService(scope, 'GetAffectedBookings', {
      service: 'dynamodb',
      action: 'query',
      parameters: {
        TableName: table.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': { S: sfn.JsonPath.format('FLIGHT#{}', sfn.JsonPath.stringAt('$.detail.flight_id')) },
          ':sk': { S: 'BOOKING#' },
        },
      },
      iamResources: [table.tableArn],
    }).addCatch(notifyFailure, {
      resultPath: '$.error',
    });

    // Process bookings if they exist
    const processBookings = this.createProcessBookingsMap(scope, table, llmMessenger, eventBus, 'DELAY_NOTIFICATION');

    // Check if bookings exist
    const checkBookings = new sfn.Choice(scope, 'CheckBookingsExist')
      .when(sfn.Condition.numberGreaterThan('$.Count', 0), processBookings)
      .otherwise(new sfn.Pass(scope, 'NoBookingsFound'));

    // UpdateFlightStatus with error handling
    const updateFlight = new sfnTasks.DynamoUpdateItem(scope, 'UpdateFlightStatus', {
      table,
      key: {
        PK: sfnTasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.format('FLIGHT#{}', sfn.JsonPath.stringAt('$.detail.flight_id'))
        ),
        SK: sfnTasks.DynamoAttributeValue.fromString('METADATA'),
      },
      updateExpression: 'SET #status = :status, delay_minutes = :delay, delay_reason = :reason, GSI1PK = :gsi1pk',
      expressionAttributeNames: {
        '#status': 'status',
      },
      expressionAttributeValues: {
        ':status': sfnTasks.DynamoAttributeValue.fromString('DELAYED'),
        ':delay': sfnTasks.DynamoAttributeValue.numberFromString(sfn.JsonPath.stringAt('$.detail.delay_minutes')),
        ':reason': sfnTasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.detail.reason')),
        ':gsi1pk': sfnTasks.DynamoAttributeValue.fromString('DELAYED'),
      },
    }).addCatch(notifyFailure, {
      resultPath: '$.error',
    });

    // Parallel execution with error handling
    const parallelExecution = new sfn.Parallel(scope, 'ProcessAndUpdate')
      .branch(checkBookings)
      .branch(updateFlight)
      .addCatch(notifyFailure, {
        resultPath: '$.error',
      });

    const definition = getBookings
      .next(parallelExecution)
      .next(new sfn.Succeed(scope, 'WorkflowComplete'));

    return new sfn.StateMachine(scope, 'DelayNotificationWorkflow', {
      definition,
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(scope, 'DelayWorkflowLogs', {
          logGroupName: FlightPulseConstants.LOG_GROUP_NAMES.DELAY_WORKFLOW,
          retention: logs.RetentionDays.ONE_WEEK,
        }),
        level: sfn.LogLevel.ALL,
      },
    });
  }

  private createProcessBookingsMap(
    scope: Construct,
    table: dynamodb.Table,
    llmMessenger: lambda.Function,
    eventBus: events.EventBus,
    messageType: string = 'DELAY_NOTIFICATION'
  ): sfn.Map {
    // GetPassengerDetails
    const getPassenger = new sfnTasks.DynamoGetItem(scope, 'GetPassengerDetails', {
      table,
      key: {
        PK: sfnTasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.format('PASSENGER#{}', sfn.JsonPath.stringAt('$.passenger_id'))
        ),
        SK: sfnTasks.DynamoAttributeValue.fromString('METADATA'),
      },
    });

    // GeneratePersonalizedMessage
    const generateMessage = new sfnTasks.LambdaInvoke(scope, 'GeneratePersonalizedMessage', {
      lambdaFunction: llmMessenger,
      payload: sfn.TaskInput.fromObject({
        passenger: sfn.JsonPath.objectAt('$.Item'),
        flight_event: sfn.JsonPath.objectAt('$$.Execution.Input.detail'),
        message_type: messageType,
      }),
      resultPath: '$.MessageResult',
    });

    // SendNotifications (Parallel)
    const sendEmail = new sfn.Choice(scope, 'CheckEmailPreference')
      .when(
        sfn.Condition.booleanEquals('$.Item.notification_preferences.email', true),
        new sfnTasks.EventBridgePutEvents(scope, 'PublishEmailEvent', {
          entries: [{
            detail: sfn.TaskInput.fromObject({
              to: sfn.JsonPath.stringAt('$.Item.email'),
              subject: sfn.JsonPath.stringAt('$.MessageResult.Payload.email_subject'),
              body: sfn.JsonPath.stringAt('$.MessageResult.Payload.email_body'),
            }),
            detailType: 'notification.email',
            source: 'flightpulse.workflow',
            eventBus,
          }],
        })
      )
      .otherwise(new sfn.Pass(scope, 'SkipEmail'));

    const sendSms = new sfn.Choice(scope, 'CheckSmsPreference')
      .when(
        sfn.Condition.booleanEquals('$.Item.notification_preferences.sms', true),
        new sfnTasks.EventBridgePutEvents(scope, 'PublishSmsEvent', {
          entries: [{
            detail: sfn.TaskInput.fromObject({
              to: sfn.JsonPath.stringAt('$.Item.phone'),
              message: sfn.JsonPath.stringAt('$.MessageResult.Payload.sms_body'),
            }),
            detailType: 'notification.sms',
            source: 'flightpulse.workflow',
            eventBus,
          }],
        })
      )
      .otherwise(new sfn.Pass(scope, 'SkipSms'));

    const sendNotifications = new sfn.Parallel(scope, 'SendNotifications')
      .branch(sendEmail)
      .branch(sendSms);

    const processBooking = getPassenger
      .next(generateMessage)
      .next(sendNotifications);

    return new sfn.Map(scope, 'ProcessBookingsInParallel', {
      itemsPath: '$.Items',
      maxConcurrency: 10,
      parameters: {
        'passenger_id.$': '$.passenger_id',
        'booking_id.$': '$.booking_id',
        'detail.$': '$$.Execution.Input.detail',
      },
    }).iterator(processBooking);
  }

  private createCancellationWorkflow(
    scope: Construct,
    table: dynamodb.Table,
    llmMessenger: lambda.Function,
    eventBus: events.EventBus,
    dlq: sqs.Queue,
    errorTopic: sns.Topic
  ): sfn.StateMachine {
    const getBookings = new sfnTasks.CallAwsService(scope, 'GetAffectedBookings', {
      service: 'dynamodb',
      action: 'query',
      parameters: {
        TableName: table.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': { S: sfn.JsonPath.format('FLIGHT#{}', sfn.JsonPath.stringAt('$.detail.flight_id')) },
          ':sk': { S: 'BOOKING#' },
        },
      },
      iamResources: [table.tableArn],
    });

    const markForRebooking = new sfn.Map(scope, 'MarkBookingsForRebooking', {
      itemsPath: '$.Items',
      maxConcurrency: 10,
    }).iterator(
      new sfnTasks.DynamoUpdateItem(scope, 'UpdateBookingStatus', {
        table,
        key: {
          PK: sfnTasks.DynamoAttributeValue.fromString(
            sfn.JsonPath.format('BOOKING#{}', sfn.JsonPath.stringAt('$.booking_id'))
          ),
          SK: sfnTasks.DynamoAttributeValue.fromString('METADATA'),
        },
        updateExpression: 'SET booking_status = :status, GSI2PK = :gsi2pk',
        expressionAttributeValues: {
          ':status': sfnTasks.DynamoAttributeValue.fromString('NEEDS_REBOOKING'),
          ':gsi2pk': sfnTasks.DynamoAttributeValue.fromString('NEEDS_REBOOKING'),
        },
      })
    );

    const updateFlight = new sfnTasks.DynamoUpdateItem(scope, 'UpdateFlightStatus', {
      table,
      key: {
        PK: sfnTasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.format('FLIGHT#{}', sfn.JsonPath.stringAt('$.detail.flight_id'))
        ),
        SK: sfnTasks.DynamoAttributeValue.fromString('METADATA'),
      },
      updateExpression: 'SET #status = :status, GSI1PK = :gsi1pk',
      expressionAttributeNames: {
        '#status': 'status',
      },
      expressionAttributeValues: {
        ':status': sfnTasks.DynamoAttributeValue.fromString('CANCELLED'),
        ':gsi1pk': sfnTasks.DynamoAttributeValue.fromString('CANCELLED'),
      },
    });

    const definition = getBookings
      .next(markForRebooking)
      .next(this.createProcessBookingsMap(scope, table, llmMessenger, eventBus, 'CANCELLATION_NOTIFICATION'))
      .next(updateFlight)
      .next(new sfn.Succeed(scope, 'WorkflowComplete'));

    return new sfn.StateMachine(scope, 'CancellationWorkflow', {
      definition,
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(scope, 'CancellationWorkflowLogs', {
          logGroupName: FlightPulseConstants.LOG_GROUP_NAMES.CANCELLATION_WORKFLOW,
          retention: logs.RetentionDays.ONE_WEEK,
        }),
        level: sfn.LogLevel.ALL,
      },
    });
  }

  private createGateChangeWorkflow(
    scope: Construct,
    table: dynamodb.Table,
    llmMessenger: lambda.Function,
    eventBus: events.EventBus,
    dlq: sqs.Queue,
    errorTopic: sns.Topic
  ): sfn.StateMachine {
    const updateGate = new sfnTasks.DynamoUpdateItem(scope, 'UpdateFlightGate', {
      table,
      key: {
        PK: sfnTasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.format('FLIGHT#{}', sfn.JsonPath.stringAt('$.detail.flight_id'))
        ),
        SK: sfnTasks.DynamoAttributeValue.fromString('METADATA'),
      },
      updateExpression: 'SET gate = :gate',
      expressionAttributeValues: {
        ':gate': sfnTasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.detail.new_gate')),
      },
    });

    const getBookings = new sfnTasks.CallAwsService(scope, 'GetAffectedBookings', {
      service: 'dynamodb',
      action: 'query',
      parameters: {
        TableName: table.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': { S: sfn.JsonPath.format('FLIGHT#{}', sfn.JsonPath.stringAt('$.detail.flight_id')) },
          ':sk': { S: 'BOOKING#' },
        },
      },
      iamResources: [table.tableArn],
    });

    const definition = updateGate
      .next(getBookings)
      .next(this.createProcessBookingsMap(scope, table, llmMessenger, eventBus, 'GATE_CHANGE_NOTIFICATION'))
      .next(new sfn.Succeed(scope, 'WorkflowComplete'));

    return new sfn.StateMachine(scope, 'GateChangeWorkflow', {
      definition,
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(scope, 'GateChangeWorkflowLogs', {
          logGroupName: FlightPulseConstants.LOG_GROUP_NAMES.GATE_CHANGE_WORKFLOW,
          retention: logs.RetentionDays.ONE_WEEK,
        }),
        level: sfn.LogLevel.ALL,
      },
    });
  }

  /**
   * Helper function to create Node.js Lambda bundling options.
   * Reusable across all Node.js Lambda functions to follow DRY principles.
   */
  private getNodeJsBundlingOptions() {
    return {
      bundling: {
        image: lambda.Runtime.NODEJS_20_X.bundlingImage,
        command: [
          'bash',
          '-c',
          'npm install && npm run build && cp -r dist/* /asset-output/ && cp -r node_modules /asset-output/',
        ],
      },
    };
  }
}
