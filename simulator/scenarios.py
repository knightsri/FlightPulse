"""
Pre-built test scenarios for FlightPulse
"""
import json
import uuid
from datetime import datetime, timedelta
from kafka import KafkaProducer

producer = KafkaProducer(
    bootstrap_servers=['localhost:9092'],
    value_serializer=lambda v: json.dumps(v).encode('utf-8')
)

TOPIC = 'flight-operations'


def scenario1_minor_delay():
    """Scenario 1: Minor Delay (< 30 min)"""
    event = {
        'event_id': str(uuid.uuid4()),
        'event_type': 'FLIGHT_DELAY',
        'timestamp': datetime.utcnow().isoformat(),
        'source': 'operations_center',
        'payload': {
            'flight_id': 'SW1234',
            'delay_minutes': 25,
            'reason': 'WEATHER',
            'reason_detail': 'Light weather conditions affecting operations',
            'new_departure': (datetime.utcnow() + timedelta(minutes=25)).isoformat(),
            'new_arrival': (datetime.utcnow() + timedelta(minutes=145)).isoformat(),
        }
    }
    producer.send(TOPIC, value=event)
    producer.flush()
    print("Scenario 1: Minor delay event sent for SW1234")


def scenario2_major_delay():
    """Scenario 2: Major Delay (30-120 min) with A-LIST passenger"""
    event = {
        'event_id': str(uuid.uuid4()),
        'event_type': 'FLIGHT_DELAY',
        'timestamp': datetime.utcnow().isoformat(),
        'source': 'operations_center',
        'payload': {
            'flight_id': 'SW5678',
            'delay_minutes': 90,
            'reason': 'MECHANICAL',
            'reason_detail': 'Aircraft maintenance required',
            'new_departure': (datetime.utcnow() + timedelta(minutes=90)).isoformat(),
            'new_arrival': (datetime.utcnow() + timedelta(minutes=210)).isoformat(),
        }
    }
    producer.send(TOPIC, value=event)
    producer.flush()
    print("Scenario 2: Major delay event sent for SW5678")


def scenario3_cancellation():
    """Scenario 3: Flight Cancellation"""
    event = {
        'event_id': str(uuid.uuid4()),
        'event_type': 'FLIGHT_CANCELLED',
        'timestamp': datetime.utcnow().isoformat(),
        'source': 'operations_center',
        'payload': {
            'flight_id': 'SW9012',
            'reason': 'WEATHER',
            'reason_detail': 'Severe weather conditions require cancellation',
            'rebooking_priority': 'HIGH',
        }
    }
    producer.send(TOPIC, value=event)
    producer.flush()
    print("Scenario 3: Cancellation event sent for SW9012")


def scenario4_gate_change():
    """Scenario 4: Gate Change with Terminal Change"""
    event = {
        'event_id': str(uuid.uuid4()),
        'event_type': 'GATE_CHANGE',
        'timestamp': datetime.utcnow().isoformat(),
        'source': 'airport_ops',
        'payload': {
            'flight_id': 'SW3456',
            'old_gate': 'A5',
            'new_gate': 'D15',
            'terminal_change': True,
        }
    }
    producer.send(TOPIC, value=event)
    producer.flush()
    print("Scenario 4: Gate change event sent for SW3456")


def scenario5_rapid_sequence():
    """Scenario 5: Rapid Sequence of Events"""
    events = [
        {
            'event_id': str(uuid.uuid4()),
            'event_type': 'FLIGHT_DELAY',
            'timestamp': datetime.utcnow().isoformat(),
            'source': 'operations_center',
            'payload': {
                'flight_id': 'SW1234',
                'delay_minutes': 15,
                'reason': 'ATC',
                'reason_detail': 'Air traffic control delay',
                'new_departure': (datetime.utcnow() + timedelta(minutes=15)).isoformat(),
                'new_arrival': (datetime.utcnow() + timedelta(minutes=135)).isoformat(),
            }
        },
        {
            'event_id': str(uuid.uuid4()),
            'event_type': 'GATE_CHANGE',
            'timestamp': datetime.utcnow().isoformat(),
            'source': 'airport_ops',
            'payload': {
                'flight_id': 'SW5678',
                'old_gate': 'B7',
                'new_gate': 'B12',
                'terminal_change': False,
            }
        },
        {
            'event_id': str(uuid.uuid4()),
            'event_type': 'FLIGHT_DELAY',
            'timestamp': datetime.utcnow().isoformat(),
            'source': 'operations_center',
            'payload': {
                'flight_id': 'SW7890',
                'delay_minutes': 45,
                'reason': 'CREW',
                'reason_detail': 'Crew scheduling delay',
                'new_departure': (datetime.utcnow() + timedelta(minutes=45)).isoformat(),
                'new_arrival': (datetime.utcnow() + timedelta(minutes=165)).isoformat(),
            }
        },
    ]
    
    for event in events:
        producer.send(TOPIC, value=event)
    
    producer.flush()
    print("Scenario 5: Rapid sequence of 3 events sent")


if __name__ == '__main__':
    import sys
    scenario = sys.argv[1] if len(sys.argv) > 1 else '1'
    
    scenarios = {
        '1': scenario1_minor_delay,
        '2': scenario2_major_delay,
        '3': scenario3_cancellation,
        '4': scenario4_gate_change,
        '5': scenario5_rapid_sequence,
    }
    
    if scenario in scenarios:
        scenarios[scenario]()
    else:
        print(f"Unknown scenario: {scenario}")
        print("Available scenarios: 1, 2, 3, 4, 5")

