export class FlightPulseConstants {
    static readonly PROJECT_NAME = 'FlightPulse';
    static readonly TABLE_NAME = 'FlightPulseTable';
    static readonly EVENT_BUS_NAME = 'flightpulse-bus';
    static readonly WORKFLOW_DLQ_NAME = 'WorkflowDLQ';
    static readonly WORKFLOW_ERROR_TOPIC_NAME = 'flightpulse-workflow-errors';
    static readonly ALARM_TOPIC_NAME = 'flightpulse-alarms';
    static readonly BEDROCK_MODEL_PARAM_NAME = '/flightpulse/bedrock/model-id';
    static readonly BEDROCK_MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';

    static readonly SERVICE_NAME = {
        KAFKA_CONSUMER: 'KafkaConsumer',
        LLM_MESSENGER: 'LLMMessenger',
        API_HANDLERS: 'ApiHandlers',
        STREAM_HANDLER: 'StreamHandler',
    };

    static readonly LOG_GROUP_NAMES = {
        API_ACCESS: '/aws/apigateway/flightpulse-api',
        EMAIL_NOTIFICATIONS: '/flightpulse/notifications/email',
        SMS_NOTIFICATIONS: '/flightpulse/notifications/sms',
        DELAY_WORKFLOW: '/aws/stepfunctions/DelayNotification',
        CANCELLATION_WORKFLOW: '/aws/stepfunctions/CancellationNotification',
        GATE_CHANGE_WORKFLOW: '/aws/stepfunctions/GateChangeNotification',
    };

    static readonly TAGS = {
        PROJECT: 'Project',
        ENVIRONMENT: 'Environment',
        MANAGED_BY: 'ManagedBy',
        COST_CENTER: 'CostCenter',
    };
}
