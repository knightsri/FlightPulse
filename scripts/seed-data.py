#!/usr/bin/env python3
"""
Seed DynamoDB with sample data
"""
import json
import boto3
import os
import sys

TABLE_NAME = os.environ.get('TABLE_NAME', 'FlightPulseTable')
REGION = os.environ.get('AWS_REGION', 'us-east-1')

dynamodb = boto3.resource('dynamodb', region_name=REGION)
table = dynamodb.Table(TABLE_NAME)


def convert_to_dynamodb_item(item):
    """Convert JSON item to DynamoDB format"""
    dynamodb_item = {}
    for key, value in item.items():
        if isinstance(value, str):
            dynamodb_item[key] = value
        elif isinstance(value, bool):
            dynamodb_item[key] = value
        elif isinstance(value, int):
            dynamodb_item[key] = value
        elif isinstance(value, dict):
            dynamodb_item[key] = value
        elif isinstance(value, list):
            dynamodb_item[key] = value
        else:
            dynamodb_item[key] = str(value)
    return dynamodb_item


def seed_flights():
    """Seed flight data"""
    print("Seeding flights...")
    with open('simulator/sample-data/flights.json', 'r') as f:
        flights = json.load(f)
    
    for flight in flights:
        item = convert_to_dynamodb_item(flight)
        table.put_item(Item=item)
        print(f"  ✓ Seeded flight {flight['flight_id']}")


def seed_passengers():
    """Seed passenger data"""
    print("Seeding passengers...")
    with open('simulator/sample-data/passengers.json', 'r') as f:
        passengers = json.load(f)
    
    for passenger in passengers:
        item = convert_to_dynamodb_item(passenger)
        table.put_item(Item=item)
        print(f"  ✓ Seeded passenger {passenger['passenger_id']}")


def seed_bookings():
    """Seed booking data"""
    print("Seeding bookings...")
    with open('simulator/sample-data/bookings.json', 'r') as f:
        bookings = json.load(f)
    
    for booking in bookings:
        item = convert_to_dynamodb_item(booking)
        table.put_item(Item=item)
        print(f"  ✓ Seeded booking {booking.get('booking_id', 'lookup')}")


def main():
    """Main function"""
    try:
        # Verify AWS credentials
        sts = boto3.client('sts', region_name=REGION)
        sts.get_caller_identity()
    except Exception as e:
        print(f"Error: AWS CLI not configured properly: {e}")
        print("Please run 'aws configure' or set AWS credentials")
        sys.exit(1)
    
    # Verify table exists
    try:
        table.load()
    except Exception as e:
        print(f"Error: Table {TABLE_NAME} does not exist: {e}")
        print("Please deploy the CDK stack first: ./scripts/deploy.sh")
        sys.exit(1)
    
    print(f"Seeding DynamoDB table: {TABLE_NAME}")
    print(f"Region: {REGION}")
    print()
    
    seed_flights()
    print()
    seed_passengers()
    print()
    seed_bookings()
    print()
    print("✓ Sample data seeded successfully!")


if __name__ == '__main__':
    main()

