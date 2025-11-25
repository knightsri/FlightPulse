#!/bin/bash
# Start Docker containers for local development

set -e

echo "Starting Kafka and Zookeeper..."

# Start Docker Compose
docker-compose up -d

echo "Waiting for Kafka to be ready..."
sleep 10

# Create topic if it doesn't exist
docker exec -it flightpulse-kafka-1 kafka-topics --create \
    --bootstrap-server localhost:9092 \
    --topic flight-operations \
    --partitions 1 \
    --replication-factor 1 \
    --if-not-exists || true

echo "Kafka is ready!"
echo "Kafka broker: localhost:9092"
echo "Topic: flight-operations"

