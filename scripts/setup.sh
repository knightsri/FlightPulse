#!/bin/bash
# One-time setup script for FlightPulse

set -e

echo "Setting up FlightPulse..."

# Install root dependencies
echo "Installing root dependencies..."
npm install

# Install infrastructure dependencies
echo "Installing infrastructure dependencies..."
cd infrastructure
npm install
cd ..

# Install Node.js Lambda dependencies
echo "Installing API handlers dependencies..."
cd lambdas/nodejs/api-handlers
npm install
cd ../../..

echo "Installing stream handler dependencies..."
cd lambdas/nodejs/stream-handler
npm install
cd ../../..

# Install Python Lambda dependencies
echo "Installing Kafka consumer dependencies..."
cd lambdas/python/kafka-consumer
pip install -r requirements.txt -t .
cd ../../..

echo "Installing LLM messenger dependencies..."
cd lambdas/python/llm-messenger
pip install -r requirements.txt -t .
cd ../../..

# Install simulator dependencies
echo "Installing simulator dependencies..."
cd simulator
pip install -r requirements.txt
cd ..

echo "Setup complete!"

