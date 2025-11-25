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
import { Construct } from 'constructs';
import * as path from 'path';

export class FlightPulseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB Table - Single Table Design
    const table = new dynamodb.Table(this, 'FlightPulseTable', {

      tableName: 'FlightPulseTable',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For demo only
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
      eventBusName: 'flightpulse-bus',
    });

    // Dead Letter Queue for Step Functions failures
    const dlq = new sqs.Queue(this, 'WorkflowDLQ', {
      retentionPeriod: cdk.Duration.days(14),
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
    });

    table.grantReadWriteData(kafkaConsumer);
    eventBus.grantPutEvents(kafkaConsumer);

    // LLM Messenger Lambda (Python)
    const llmMessenger = new lambda.Function(this, 'LLMMessenger', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambdas/python/llm-messenger')),
      environment: {
        TABLE_NAME: table.tableName,
        BEDROCK_MODEL_ID: 'anthropic.claude-3-haiku-20240307-v1:0',
      },
      timeout: cdk.Duration.seconds(60),
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });
    llmMessenger.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: ['arn:aws:bedrock:*::foundation-model/anthropic.claude-3-haiku-20240307-v1:0'],
    }));
    table.grantReadData(llmMessenger);

    // API Handlers Lambda (Node.js)
    const apiHandlers = new lambda.Function(this, 'ApiHandlers', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambdas/nodejs/api-handlers'), {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash', '-c',
            'npm install && npm run build && cp -r dist/* /asset-output/ && cp -r node_modules /asset-output/',
          ],
        },
      }),
      environment: {
        TABLE_NAME: table.tableName,
      },
      timeout: cdk.Duration.seconds(10),
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    table.grantReadData(apiHandlers);

    // Stream Handler Lambda (Node.js)
    const streamHandler = new lambda.Function(this, 'StreamHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambdas/nodejs/stream-handler'), {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash', '-c',
            'npm install && npm run build && cp -r dist/* /asset-output/ && cp -r node_modules /asset-output/',
          ],
        },
      }),
      environment: {
        EVENT_BUS_NAME: eventBus.eventBusName,
      },
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    eventBus.grantPutEvents(streamHandler);

    // DynamoDB Stream → Stream Handler
    streamHandler.addEventSourceMapping('StreamEventSource', {
      eventSourceArn: table.tableStreamArn!,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 10,
    });

    // Step Functions State Machines
    const delayWorkflow = this.createDelayWorkflow(this, table, llmMessenger, eventBus, dlq);
    const cancellationWorkflow = this.createCancellationWorkflow(this, table, llmMessenger, eventBus, dlq);
    const gateChangeWorkflow = this.createGateChangeWorkflow(this, table, llmMessenger, eventBus, dlq);

    // EventBridge Rules
    eventBus.addRule('DelayMinorRule', {
      eventPattern: {
        source: ['flightpulse.kafka-consumer'],
        detailType: ['flight.delay.minor'],
      },
      targets: [new targets.SfnStateMachine(delayWorkflow)],
    });

    eventBus.addRule('DelayMajorRule', {
      eventPattern: {
        source: ['flightpulse.kafka-consumer'],
        detailType: ['flight.delay.major'],
      },
      targets: [new targets.SfnStateMachine(delayWorkflow)],
    });

    eventBus.addRule('DelaySevereRule', {
      eventPattern: {
        source: ['flightpulse.kafka-consumer'],
        detailType: ['flight.delay.severe'],
      },
      targets: [new targets.SfnStateMachine(delayWorkflow)],
    });

    eventBus.addRule('CancellationRule', {
      eventPattern: {
        source: ['flightpulse.kafka-consumer'],
        detailType: ['flight.cancelled'],
      },
      targets: [new targets.SfnStateMachine(cancellationWorkflow)],
    });

    eventBus.addRule('GateChangeRule', {
      eventPattern: {
        source: ['flightpulse.kafka-consumer'],
        detailType: ['flight.gate_change'],
      },
      targets: [new targets.SfnStateMachine(gateChangeWorkflow)],
    });

    // Notification rules (mock to CloudWatch)
    eventBus.addRule('NotificationEmailRule', {
      eventPattern: {
        detailType: ['notification.email'],
      },
      targets: [new targets.CloudWatchLogGroup(
        new logs.LogGroup(this, 'EmailNotificationsLog', {
          logGroupName: '/flightpulse/notifications/email',
          retention: logs.RetentionDays.ONE_WEEK,
        })
      )],
    });

    eventBus.addRule('NotificationSmsRule', {
      eventPattern: {
        detailType: ['notification.sms'],
      },
      targets: [new targets.CloudWatchLogGroup(
        new logs.LogGroup(this, 'SmsNotificationsLog', {
          logGroupName: '/flightpulse/notifications/sms',
          retention: logs.RetentionDays.ONE_WEEK,
        })
      )],
    });

    // API Gateway
    const api = new apigateway.RestApi(this, 'FlightPulseApi', {
      restApiName: 'FlightPulse API',
      description: 'FlightPulse REST API',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
      // Enable basic throttling to protect against abuse
      defaultMethodOptions: {
        throttlingRateLimit: 100, // 100 requests per second
        throttlingBurstLimit: 200,
      },
    });

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

    // Outputs
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'EventBusName', { value: eventBus.eventBusName });
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
  }

  private createDelayWorkflow(
    scope: Construct,
    table: dynamodb.Table,
    llmMessenger: lambda.Function,
    eventBus: events.EventBus,
    dlq: sqs.Queue
  ): sfn.StateMachine {
    // GetAffectedBookings
    const getBookings = new sfnTasks.DynamoDBQuery(scope, 'GetAffectedBookings', {
      table,
      keyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      expressionAttributeValues: {
        ':pk': sfnTasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.format('FLIGHT#{}', sfn.JsonPath.stringAt('$.detail.flight_id'))
        ),
        ':sk': sfnTasks.DynamoAttributeValue.fromString('BOOKING#'),
      },
    });

    // Process bookings if they exist
    const processBookings = this.createProcessBookingsMap(scope, table, llmMessenger, eventBus, 'DELAY_NOTIFICATION');

    // Check if bookings exist
    const checkBookings = new sfn.Choice(scope, 'CheckBookingsExist')
      .when(sfn.Condition.numberGreaterThan('$.Count', 0), processBookings)
      .otherwise(new sfn.Pass(scope, 'NoBookingsFound'));

    // UpdateFlightStatus (always executed)
    const updateFlight = new sfnTasks.DynamoDBUpdateItem(scope, 'UpdateFlightStatus', {
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
    });

    // Parallel execution: process bookings and update flight status
    const parallelExecution = new sfn.Parallel(scope, 'ProcessAndUpdate')
      .branch(checkBookings)
      .branch(updateFlight);

    const definition = getBookings
      .next(parallelExecution)
      .next(new sfn.Succeed(scope, 'WorkflowComplete'));

    return new sfn.StateMachine(scope, 'DelayNotificationWorkflow', {
      definition,
      tracingEnabled: true,
      deadLetterQueueEnabled: true,
      deadLetterQueue: dlq,
      logs: {
        destination: new logs.LogGroup(scope, 'DelayWorkflowLogs', {
          logGroupName: '/aws/stepfunctions/DelayNotification',
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
    const getPassenger = new sfnTasks.DynamoDBGetItem(scope, 'GetPassengerDetails', {
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
          }],
          eventBus,
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
          }],
          eventBus,
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
    dlq: sqs.Queue
  ): sfn.StateMachine {
    const getBookings = new sfnTasks.DynamoDBQuery(scope, 'GetAffectedBookings', {
      table,
      keyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      expressionAttributeValues: {
        ':pk': sfnTasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.format('FLIGHT#{}', sfn.JsonPath.stringAt('$.detail.flight_id'))
        ),
        ':sk': sfnTasks.DynamoAttributeValue.fromString('BOOKING#'),
      },
    });

    const markForRebooking = new sfn.Map(scope, 'MarkBookingsForRebooking', {
      itemsPath: '$.Items',
      maxConcurrency: 10,
    }).iterator(
      new sfnTasks.DynamoDBUpdateItem(scope, 'UpdateBookingStatus', {
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

    const updateFlight = new sfnTasks.DynamoDBUpdateItem(scope, 'UpdateFlightStatus', {
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
      deadLetterQueueEnabled: true,
      deadLetterQueue: dlq,
    });
  }

  private createGateChangeWorkflow(
    scope: Construct,
    table: dynamodb.Table,
    llmMessenger: lambda.Function,
    eventBus: events.EventBus,
    dlq: sqs.Queue
  ): sfn.StateMachine {
    const updateGate = new sfnTasks.DynamoDBUpdateItem(scope, 'UpdateFlightGate', {
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

    const getBookings = new sfnTasks.DynamoDBQuery(scope, 'GetAffectedBookings', {
      table,
      keyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      expressionAttributeValues: {
        ':pk': sfnTasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.format('FLIGHT#{}', sfn.JsonPath.stringAt('$.detail.flight_id'))
        ),
        ':sk': sfnTasks.DynamoAttributeValue.fromString('BOOKING#'),
      },
    });

    const definition = updateGate
      .next(getBookings)
      .next(this.createProcessBookingsMap(scope, table, llmMessenger, eventBus, 'GATE_CHANGE_NOTIFICATION'))
      .next(new sfn.Succeed(scope, 'WorkflowComplete'));

    return new sfn.StateMachine(scope, 'GateChangeWorkflow', {
      definition,
      tracingEnabled: true,
      deadLetterQueueEnabled: true,
      deadLetterQueue: dlq,
    });
  }
}
