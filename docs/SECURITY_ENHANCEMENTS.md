# Security Enhancements – Feature Branch

## Changes Implemented

### ✅ 1. Parameterized Removal Policy
**Problem**: DynamoDB table had hard-coded `DESTROY` removal policy, risking data loss in production.

**Solution**:
- Added configurable `removalPolicy` context variable in `cdk.json`
- Defaults to `RETAIN` for production safety
- Can be set to `destroy` for dev/test environments via CDK context

```typescript
const removalPolicy = this.node.tryGetContext('removalPolicy') === 'destroy' 
  ? cdk.RemovalPolicy.DESTROY 
  : cdk.RemovalPolicy.RETAIN;
```

**Usage**:
```bash
# For development (allows table deletion)
cdk deploy -c removalPolicy=destroy

# For production (prevents accidental deletion) - default
cdk deploy
```

---

### ✅ 2. Scoped Bedrock IAM Policy
**Problem**: IAM policy used wildcard region (`*`) for Bedrock model ARN, over-privileging the Lambda.

**Solution**:
- Scoped the policy to the specific region using `${this.region}`
- Added explicit `Effect.ALLOW` for clarity
- Maintains least-privilege access

```typescript
llmMessenger.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['bedrock:InvokeModel'],
  resources: [
    `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`
  ],
}));
```

---

### ✅ 3. Increased LLM Lambda Timeout
**Problem**: 60-second timeout may be insufficient for LLM API calls under load.

**Solution**:
- Increased timeout from 60s → **120s**
- Restored `memorySize: 512` configuration
- Reduces risk of timeout errors during heavy processing

```typescript
const llmMessenger = new lambda.Function(this, 'LLMMessenger', {
  timeout: cdk.Duration.seconds(120), // Increased for LLM processing
  memorySize: 512,
  // ...
});
```

---

## Next Steps (from Implementation Plan)

### Pending Security Items:
- [ ] **VPC Configuration**: Deploy Lambdas in a VPC with private subnets and VPC endpoints
- [ ] **Secrets Manager**: Move `BEDROCK_MODEL_ID` from environment variable to SSM Parameter Store

### Reliability & Error Handling:
- [ ] Add `addCatch` blocks to Step Functions tasks
- [ ] Create CloudWatch alarms for Lambda timeouts/errors

### Observability:
- [ ] Enable API Gateway access logs
- [ ] Add CloudWatch alarms for DynamoDB throttling
- [ ] Apply standard tags to all resources

### Maintainability:
- [ ] Extract Node.js bundling config into helper function
- [ ] Replace hard-coded resource names with parameters
- [ ] Add CDK unit tests

---

## Testing

After installing dependencies:
```bash
npm install
npm run build
cdk synth
```

The stack should synthesize successfully with the new security improvements.

---

*Part of security-enhancements feature branch*
