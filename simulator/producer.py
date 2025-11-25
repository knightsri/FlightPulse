import json
import uuid
from datetime import datetime, timedelta
from kafka import KafkaProducer
import argparse

producer = KafkaProducer(
    bootstrap_servers=['localhost:9092'],
    value_serializer=lambda v: json.dumps(v).encode('utf-8')
)

TOPIC = 'flight-operations'


def produce_delay_event(flight_id: str, delay_minutes: int, reason: str = 'WEATHER'):
    event = {
        'event_id': str(uuid.uuid4()),
        'event_type': 'FLIGHT_DELAY',
        'timestamp': datetime.utcnow().isoformat(),
        'source': 'operations_center',
        'payload': {
            'flight_id': flight_id,
            'delay_minutes': delay_minutes,
            'reason': reason,
            'reason_detail': f'{reason} conditions affecting operations',
            'new_departure': (datetime.utcnow() + timedelta(minutes=delay_minutes)).isoformat(),
            'new_arrival': (datetime.utcnow() + timedelta(minutes=delay_minutes + 120)).isoformat(),
        }
    }
    producer.send(TOPIC, value=event)
    print(f"Sent delay event for {flight_id}: {delay_minutes} min delay")


def produce_cancellation_event(flight_id: str, reason: str = 'WEATHER'):
    event = {
        'event_id': str(uuid.uuid4()),
        'event_type': 'FLIGHT_CANCELLED',
        'timestamp': datetime.utcnow().isoformat(),
        'source': 'operations_center',
        'payload': {
            'flight_id': flight_id,
            'reason': reason,
            'reason_detail': f'{reason} conditions require cancellation',
            'rebooking_priority': 'HIGH',
        }
    }
    producer.send(TOPIC, value=event)
    print(f"Sent cancellation event for {flight_id}")


def produce_gate_change_event(flight_id: str, old_gate: str, new_gate: str, terminal_change: bool = False):
    event = {
        'event_id': str(uuid.uuid4()),
        'event_type': 'GATE_CHANGE',
        'timestamp': datetime.utcnow().isoformat(),
        'source': 'airport_ops',
        'payload': {
            'flight_id': flight_id,
            'old_gate': old_gate,
            'new_gate': new_gate,
            'terminal_change': terminal_change,
        }
    }
    producer.send(TOPIC, value=event)
    print(f"Sent gate change event for {flight_id}: {old_gate} → {new_gate}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Produce Kafka events')
    parser.add_argument('--event-type', required=True, choices=['FLIGHT_DELAY', 'FLIGHT_CANCELLED', 'GATE_CHANGE'])
    parser.add_argument('--flight-id', required=True)
    parser.add_argument('--delay-minutes', type=int)
    parser.add_argument('--reason', default='WEATHER')
    parser.add_argument('--old-gate')
    parser.add_argument('--new-gate')
    parser.add_argument('--terminal-change', action='store_true')

    args = parser.parse_args()

    if args.event_type == 'FLIGHT_DELAY':
        produce_delay_event(args.flight_id, args.delay_minutes or 30, args.reason)
    elif args.event_type == 'FLIGHT_CANCELLED':
        produce_cancellation_event(args.flight_id, args.reason)
    elif args.event_type == 'GATE_CHANGE':
        produce_gate_change_event(args.flight_id, args.old_gate, args.new_gate, args.terminal_change)

    producer.flush()

