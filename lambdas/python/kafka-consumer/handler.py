import json
import os
import boto3
from datetime import datetime
from typing import Dict, Any
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.metrics import MetricUnit

logger = Logger()
tracer = Tracer()
metrics = Metrics()

eventbridge = boto3.client('events')
dynamodb = boto3.resource('dynamodb')

TABLE_NAME = os.environ['TABLE_NAME']
EVENT_BUS_NAME = os.environ['EVENT_BUS_NAME']
table = dynamodb.Table(TABLE_NAME)


def categorize_delay(delay_minutes: int) -> str:
    """Categorize delay into minor, major, or severe."""
    if delay_minutes < 30:
        return 'minor'
    elif delay_minutes <= 120:
        return 'major'
    else:
        return 'severe'


def enrich_flight_details(flight_id: str) -> Dict[str, Any]:
    """Fetch flight details from DynamoDB."""
    try:
        response = table.get_item(
            Key={
                'PK': f'FLIGHT#{flight_id}',
                'SK': 'METADATA'
            }
        )
        if 'Item' in response:
            return {
                'origin': response['Item'].get('origin'),
                'destination': response['Item'].get('destination'),
                'original_departure': response['Item'].get('scheduled_departure'),
            }
    except Exception as e:
        logger.error(f"Error fetching flight details: {e}")
    return {}


def count_affected_passengers(flight_id: str) -> int:
    """Count bookings for a flight."""
    try:
        response = table.query(
            KeyConditionExpression='PK = :pk AND begins_with(SK, :sk)',
            ExpressionAttributeValues={
                ':pk': f'FLIGHT#{flight_id}',
                ':sk': 'BOOKING#'
            },
            Select='COUNT'
        )
        return response.get('Count', 0)
    except Exception as e:
        logger.error(f"Error counting passengers: {e}")
        return 0


@tracer.capture_lambda_handler
@logger.inject_lambda_context
@metrics.log_metrics
def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Process Kafka events and publish to EventBridge."""
    try:
        # Parse Kafka event (simplified - adjust based on your Kafka integration)
        # For API Gateway integration, event body is a string
        if isinstance(event.get('body'), str):
            kafka_event = json.loads(event.get('body', '{}'))
        else:
            kafka_event = event.get('body', event)
        
        event_type = kafka_event.get('event_type')
        payload = kafka_event.get('payload', {})
        flight_id = payload.get('flight_id')
        
        logger.info(f"Processing {event_type} for flight {flight_id}")
        
        if event_type == 'FLIGHT_DELAY':
            delay_minutes = payload.get('delay_minutes', 0)
            category = categorize_delay(delay_minutes)
            detail_type = f'flight.delay.{category}'
            
            # Enrich event
            flight_details = enrich_flight_details(flight_id)
            affected_count = count_affected_passengers(flight_id)
            
            eventbridge_event = {
                'source': 'flightpulse.kafka-consumer',
                'detail-type': detail_type,
                'detail': {
                    'event_id': kafka_event.get('event_id'),
                    'flight_id': flight_id,
                    'delay_minutes': delay_minutes,
                    'delay_category': category.upper(),
                    'reason': payload.get('reason'),
                    'reason_detail': payload.get('reason_detail'),
                    'affected_passengers_count': affected_count,
                    'new_departure': payload.get('new_departure'),
                    'new_arrival': payload.get('new_arrival'),
                    'flight_details': flight_details,
                    'timestamp': kafka_event.get('timestamp', datetime.utcnow().isoformat()),
                }
            }
            
            metrics.add_metric(name='DelayEventsProcessed', unit=MetricUnit.Count, value=1)
            
        elif event_type == 'FLIGHT_CANCELLED':
            eventbridge_event = {
                'source': 'flightpulse.kafka-consumer',
                'detail-type': 'flight.cancelled',
                'detail': {
                    'event_id': kafka_event.get('event_id'),
                    'flight_id': flight_id,
                    'reason': payload.get('reason'),
                    'reason_detail': payload.get('reason_detail'),
                    'rebooking_priority': payload.get('rebooking_priority'),
                    'affected_passengers_count': count_affected_passengers(flight_id),
                    'timestamp': kafka_event.get('timestamp', datetime.utcnow().isoformat()),
                }
            }
            
            metrics.add_metric(name='CancellationEventsProcessed', unit=MetricUnit.Count, value=1)
            
        elif event_type == 'GATE_CHANGE':
            eventbridge_event = {
                'source': 'flightpulse.kafka-consumer',
                'detail-type': 'flight.gate_change',
                'detail': {
                    'event_id': kafka_event.get('event_id'),
                    'flight_id': flight_id,
                    'old_gate': payload.get('old_gate'),
                    'new_gate': payload.get('new_gate'),
                    'terminal_change': payload.get('terminal_change', False),
                    'timestamp': kafka_event.get('timestamp', datetime.utcnow().isoformat()),
                }
            }
            
            metrics.add_metric(name='GateChangeEventsProcessed', unit=MetricUnit.Count, value=1)
            
        else:
            logger.warning(f"Unknown event type: {event_type}")
            return {'statusCode': 400, 'body': json.dumps({'error': 'Unknown event type'})}
        
        # Publish to EventBridge
        response = eventbridge.put_events(
            Entries=[{
                'EventBusName': EVENT_BUS_NAME,
                **eventbridge_event
            }]
        )
        
        logger.info(f"Published event to EventBridge: {response}")
        
        return {
            'statusCode': 200,
            'body': json.dumps({'message': 'Event processed successfully'})
        }
        
    except Exception as e:
        logger.error(f"Error processing event: {e}", exc_info=True)
        metrics.add_metric(name='ProcessingErrors', unit=MetricUnit.Count, value=1)
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }

