#!/bin/bash
# Run a test scenario

set -e

SCENARIO="${1:-1}"

if [ -z "$1" ]; then
    echo "Usage: $0 <scenario_number>"
    echo "Available scenarios:"
    echo "  1 - Minor delay (< 30 min)"
    echo "  2 - Major delay (30-120 min)"
    echo "  3 - Flight cancellation"
    echo "  4 - Gate change with terminal change"
    echo "  5 - Rapid sequence of events"
    exit 1
fi

# Check if Kafka is running
if ! docker ps | grep -q kafka; then
    echo "Error: Kafka is not running. Please run './scripts/start-local.sh' first"
    exit 1
fi

# Run scenario
echo "Running scenario $SCENARIO..."
cd simulator
python scenarios.py "$SCENARIO"
cd ..

echo "Scenario $SCENARIO completed!"

