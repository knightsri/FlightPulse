#!/bin/bash
# Seed DynamoDB with sample data (wrapper script)

# Use Python script if available, otherwise fall back to AWS CLI
if command -v python3 &> /dev/null && [ -f "scripts/seed-data.py" ]; then
    python3 scripts/seed-data.py
else
    echo "Python script not found. Please install Python 3 and boto3."
    echo "Alternatively, use AWS CLI directly (requires jq)."
    exit 1
fi

