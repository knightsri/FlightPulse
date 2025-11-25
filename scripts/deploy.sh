#!/bin/bash
# Deploy FlightPulse stack to AWS

set -e

echo "Deploying FlightPulse stack..."

# Build TypeScript
echo "Building TypeScript..."
npm run build

# Build Lambda functions
echo "Building Lambda functions..."
cd lambdas/nodejs/api-handlers && npm run build && cd ../../..
cd lambdas/nodejs/stream-handler && npm run build && cd ../../..

# Deploy CDK stack
echo "Deploying CDK stack..."
cdk deploy --require-approval never

echo "Deployment complete!"

