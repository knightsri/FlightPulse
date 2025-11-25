import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';

export interface MonitoringConstructProps {
    /**
     * Email address to receive alarm notifications
     */
    readonly alarmEmail?: string;

    /**
     * Lambda functions to monitor
     */
    readonly lambdaFunctions: lambda.Function[];

    /**
     * DynamoDB table to monitor
     */
    readonly table: dynamodb.Table;

    /**
     * Step Functions state machines to monitor
     */
    readonly stateMachines: sfn.StateMachine[];
}

/**
 * Monitoring construct that creates CloudWatch alarms and SNS notifications
 * for critical infrastructure components.
 */
export class MonitoringConstruct extends Construct {
    public readonly alarmTopic: sns.Topic;

    constructor(scope: Construct, id: string, props: MonitoringConstructProps) {
        super(scope, id);

        // Create SNS topic for alarm notifications
        this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
            displayName: 'FlightPulse Alarms',
            topicName: 'flightpulse-alarms',
        });

        // Subscribe email if provided
        if (props.alarmEmail) {
            this.alarmTopic.addSubscription(
                new subscriptions.EmailSubscription(props.alarmEmail)
            );
        }

        // Create Lambda alarms
        this.createLambdaAlarms(props.lambdaFunctions);

        // Create DynamoDB alarms
        this.createDynamoDBAlarms(props.table);

        // Create Step Functions alarms
        this.createStateMachineAlarms(props.stateMachines);

        // Tag all alarms
        cdk.Tags.of(this).add('Component', 'Monitoring');
    }

    private createLambdaAlarms(functions: lambda.Function[]): void {
        functions.forEach((fn) => {
            const functionName = fn.functionName;

            // Alarm: High error rate
            const errorAlarm = new cloudwatch.Alarm(this, `${functionName}ErrorAlarm`, {
                alarmName: `${functionName}-Errors`,
                alarmDescription: `${functionName} has high error rate`,
                metric: fn.metricErrors({
                    statistic: cloudwatch.Stats.SUM,
                    period: cdk.Duration.minutes(5),
                }),
                threshold: 5, // 5 errors in 5 minutes
                evaluationPeriods: 1,
                comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            });
            errorAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));

            // Alarm: High throttle rate
            const throttleAlarm = new cloudwatch.Alarm(this, `${functionName}ThrottleAlarm`, {
                alarmName: `${functionName}-Throttles`,
                alarmDescription: `${functionName} is being throttled`,
                metric: fn.metricThrottles({
                    statistic: cloudwatch.Stats.SUM,
                    period: cdk.Duration.minutes(5),
                }),
                threshold: 5,
                evaluationPeriods: 1,
                comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            });
            throttleAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));

            // Alarm: High duration (near timeout)
            const durationAlarm = new cloudwatch.Alarm(this, `${functionName}DurationAlarm`, {
                alarmName: `${functionName}-HighDuration`,
                alarmDescription: `${functionName} execution time is approaching timeout`,
                metric: fn.metricDuration({
                    statistic: cloudwatch.Stats.AVERAGE,
                    period: cdk.Duration.minutes(5),
                }),
                threshold: (fn.timeout?.toMilliseconds() || 3000) * 0.8, // 80% of timeout
                evaluationPeriods: 2,
                comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            });
            durationAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));
        });
    }

    private createDynamoDBAlarms(table: dynamodb.Table): void {
        // Alarm: Read throttle events
        const readThrottleAlarm = new cloudwatch.Alarm(this, 'DynamoDBReadThrottle', {
            alarmName: `${table.tableName}-ReadThrottles`,
            alarmDescription: `${table.tableName} is experiencing read throttles`,
            metric: table.metricUserErrors({
                statistic: cloudwatch.Stats.SUM,
                period: cdk.Duration.minutes(5),
            }),
            threshold: 5,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        readThrottleAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));

        // Alarm: System errors
        const systemErrorAlarm = new cloudwatch.Alarm(this, 'DynamoDBSystemErrors', {
            alarmName: `${table.tableName}-SystemErrors`,
            alarmDescription: `${table.tableName} is experiencing system errors`,
            metric: table.metricSystemErrorsForOperations({
                operations: [dynamodb.Operation.GET_ITEM, dynamodb.Operation.PUT_ITEM, dynamodb.Operation.QUERY],
                statistic: cloudwatch.Stats.SUM,
                period: cdk.Duration.minutes(5),
            }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        systemErrorAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));
    }

    private createStateMachineAlarms(stateMachines: sfn.StateMachine[]): void {
        stateMachines.forEach((sm) => {
            const smName = sm.stateMachineName;

            // Alarm: Execution failures
            const failureAlarm = new cloudwatch.Alarm(this, `${smName}FailureAlarm`, {
                alarmName: `${smName}-ExecutionFailures`,
                alarmDescription: `${smName} executions are failing`,
                metric: sm.metricFailed({
                    statistic: cloudwatch.Stats.SUM,
                    period: cdk.Duration.minutes(5),
                }),
                threshold: 2, // 2 failures in 5 minutes
                evaluationPeriods: 1,
                comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            });
            failureAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));

            // Alarm: Timed out executions
            const timeoutAlarm = new cloudwatch.Alarm(this, `${smName}TimeoutAlarm`, {
                alarmName: `${smName}-ExecutionTimeouts`,
                alarmDescription: `${smName} executions are timing out`,
                metric: sm.metricTimedOut({
                    statistic: cloudwatch.Stats.SUM,
                    period: cdk.Duration.minutes(5),
                }),
                threshold: 1,
                evaluationPeriods: 1,
                comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            });
            timeoutAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));
        });
    }

    /**
     * Create a CloudWatch Dashboard for monitoring
     */
    public createDashboard(
        lambdaFunctions: lambda.Function[],
        table: dynamodb.Table,
        stateMachines: sfn.StateMachine[]
    ): cloudwatch.Dashboard {
        const dashboard = new cloudwatch.Dashboard(this, 'FlightPulseDashboard', {
            dashboardName: 'FlightPulse-Monitoring',
        });

        // Lambda metrics widgets
        const lambdaWidgets = lambdaFunctions.map((fn) =>
            new cloudwatch.GraphWidget({
                title: `${fn.functionName} - Errors & Throttles`,
                left: [fn.metricErrors(), fn.metricThrottles()],
                width: 12,
            })
        );

        // DynamoDB widget
        const dynamoWidget = new cloudwatch.GraphWidget({
            title: `${table.tableName} - Operations`,
            left: [
                table.metricConsumedReadCapacityUnits(),
                table.metricConsumedWriteCapacityUnits(),
            ],
            right: [table.metricUserErrors()],
            width: 24,
        });

        // Step Functions widgets
        const sfnWidgets = stateMachines.map((sm) =>
            new cloudwatch.GraphWidget({
                title: `${sm.stateMachineName} - Executions`,
                left: [sm.metricSucceeded(), sm.metricFailed(), sm.metricTimedOut()],
                width: 12,
            })
        );

        dashboard.addWidgets(dynamoWidget);
        dashboard.addWidgets(...lambdaWidgets.slice(0, 2)); // First row: 2 Lambda widgets
        dashboard.addWidgets(...lambdaWidgets.slice(2)); // Second row: remaining Lambdas
        dashboard.addWidgets(...sfnWidgets);

        return dashboard;
    }
}
