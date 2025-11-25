import json
import os
import boto3
from typing import Dict, Any
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.metrics import MetricUnit

logger = Logger()
tracer = Tracer()
metrics = Metrics()

bedrock = boto3.client('bedrock-runtime')
ssm = boto3.client('ssm')

# Read model ID from SSM Parameter Store (more secure than environment variable)
BEDROCK_MODEL_PARAM = os.environ.get('BEDROCK_MODEL_PARAM', '/flightpulse/bedrock/model-id')

def get_model_id() -> str:
    """Retrieve Bedrock model ID from SSM Parameter Store."""
    try:
        response = ssm.get_parameter(Name=BEDROCK_MODEL_PARAM, WithDecryption=True)
        return response['Parameter']['Value']
    except Exception as e:
        logger.warning(f"Failed to retrieve model ID from SSM: {e}, using default")
        return 'anthropic.claude-3-haiku-20240307-v1:0'

# Cache model ID for the lifetime of the Lambda container
MODEL_ID = get_model_id()


def generate_template_message(passenger: Dict[str, Any], flight_event: Dict[str, Any], message_type: str) -> Dict[str, str]:
    """Fallback template messages."""
    first_name = passenger.get('first_name', 'Valued Passenger')
    flight_id = flight_event.get('flight_id', 'your flight')
    
    if message_type == 'DELAY_NOTIFICATION':
        delay_minutes = flight_event.get('delay_minutes', 0)
        return {
            'email_subject': f'Flight {flight_id} Delay Update',
            'email_body': f'Dear {first_name},\n\nYour flight {flight_id} has been delayed by {delay_minutes} minutes. We apologize for any inconvenience.',
            'sms_body': f'{first_name}, Flight {flight_id} delayed {delay_minutes} min. Check email for details.'
        }
    elif message_type == 'CANCELLATION_NOTIFICATION':
        return {
            'email_subject': f'Flight {flight_id} Cancellation',
            'email_body': f'Dear {first_name},\n\nWe regret to inform you that flight {flight_id} has been cancelled. Our team will assist with rebooking.',
            'sms_body': f'{first_name}, Flight {flight_id} cancelled. Check email for rebooking options.'
        }
    elif message_type == 'GATE_CHANGE_NOTIFICATION':
        new_gate = flight_event.get('new_gate', 'TBD')
        return {
            'email_subject': f'Flight {flight_id} Gate Change',
            'email_body': f'Dear {first_name},\n\nYour flight {flight_id} gate has changed to {new_gate}. Please proceed to the new gate.',
            'sms_body': f'{first_name}, Flight {flight_id} gate changed to {new_gate}.'
        }
    
    return {
        'email_subject': 'Flight Update',
        'email_body': f'Dear {first_name},\n\nThere has been an update to your flight.',
        'sms_body': f'{first_name}, Flight update. Check email for details.'
    }


@tracer.capture_lambda_handler
@logger.inject_lambda_context
@metrics.log_metrics
def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, str]:
    """Generate personalized notification messages using LLM."""
    try:
        passenger = event.get('passenger', {})
        flight_event = event.get('flight_event', {})
        message_type = event.get('message_type', 'DELAY_NOTIFICATION')
        
        first_name = passenger.get('first_name', 'Valued Passenger')
        tier = passenger.get('tier', 'MEMBER')
        special_requests = passenger.get('special_requests', [])
        
        # Build prompt
        prompt = f"""Generate a personalized, empathetic notification message for an airline passenger.

Passenger Details:
- Name: {first_name}
- Tier: {tier}
- Special Requests: {', '.join(special_requests) if special_requests else 'None'}

Flight Event:
- Type: {message_type}
- Flight ID: {flight_event.get('flight_id')}
- Details: {json.dumps(flight_event, indent=2)}

Requirements:
1. Address passenger by first name
2. {"Acknowledge A-LIST status with priority language" if tier in ['A-LIST', 'A-LIST PREFERRED'] else "Use standard friendly tone"}
3. {"Mention special assistance needs" if special_requests else ""}
4. Adjust tone: {"informative" if message_type == 'DELAY_NOTIFICATION' else "apologetic" if message_type == 'CANCELLATION_NOTIFICATION' else "urgent"}
5. Include actionable next steps
6. Keep SMS under 160 characters

Generate JSON response with:
- email_subject: Brief subject line
- email_body: 2-3 paragraph message
- sms_body: Concise message under 160 chars
"""

        try:
            # Invoke Bedrock
            response = bedrock.invoke_model(
                modelId=MODEL_ID,
                body=json.dumps({
                    'anthropic_version': 'bedrock-2023-05-31',
                    'max_tokens': 1000,
                    'messages': [{
                        'role': 'user',
                        'content': prompt
                    }]
                })
            )
            
            response_body = json.loads(response['body'].read())
            content = response_body.get('content', [{}])[0].get('text', '')
            
            # Parse LLM response (try to extract JSON)
            try:
                # Look for JSON in the response
                import re
                json_match = re.search(r'\{.*\}', content, re.DOTALL)
                if json_match:
                    result = json.loads(json_match.group())
                else:
                    raise ValueError("No JSON found in response")
            except:
                # Fallback to template
                logger.warning("Failed to parse LLM response, using template")
                result = generate_template_message(passenger, flight_event, message_type)
            
            metrics.add_metric(name='LLMInvocationsSuccess', unit=MetricUnit.Count, value=1)
            return result
            
        except Exception as e:
            logger.error(f"LLM invocation failed: {e}", exc_info=True)
            metrics.add_metric(name='LLMInvocationsFailed', unit=MetricUnit.Count, value=1)
            return generate_template_message(passenger, flight_event, message_type)
            
    except Exception as e:
        logger.error(f"Error generating message: {e}", exc_info=True)
        return generate_template_message(passenger, flight_event, message_type)

