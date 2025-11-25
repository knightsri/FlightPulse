#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FlightPulseStack } from '../lib/flightpulse-stack';

const app = new cdk.App();
new FlightPulseStack(app, 'FlightPulseStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
});

