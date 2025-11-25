# FlightPulse CDK Stack – Code Review & Implementation Plan

## 1. High‑Level Overview
The `FlightPulseStack` defines the core AWS infrastructure for the FlightPulse application:
- **DynamoDB single‑table design** with two GSIs for status and booking queries.
- **EventBridge bus** for decoupled event routing.
- **Step Functions** workflows for delay, cancellation, and gate‑change handling.
- **Lambda functions** (Python for Kafka consumer & LLM messenger, Node.js for API & stream handling).
- **API Gateway** exposing REST endpoints.
- **CloudWatch LogGroups** used as mock notification sinks.

The stack compiles successfully after fixing stray import statements and duplicate class definitions.

---

## 2. Detailed Code Review Findings
| Category | Observation | Impact | Recommendation |
|----------|--------------|--------|----------------|
| **Security** | 1. Lambda functions use broad IAM permissions (`bedrock:InvokeModel` on a wildcard ARN). | Potential over‑privilege if the model ARN changes or other resources are added. | Scope the policy to the exact model ARN and limit actions to only what is required. |
| | 2. No explicit **VPC** configuration for Lambdas that access private resources (e.g., Kafka, Bedrock). | Lambdas may run in the public internet, increasing attack surface. | Deploy Lambdas in a VPC with appropriate security groups, or use VPC‑endpoint for Bedrock. |
| | 3. `removalPolicy: DESTROY` on the DynamoDB table is set for demo only. | In production, data loss on stack deletion. | Make removal policy configurable via context/parameter; default to `RETAIN` for prod. |
| | 4. Environment variables expose `BEDROCK_MODEL_ID` directly. | Might be leaked via logs or Lambda environment. | Store sensitive IDs in **AWS Secrets Manager** or **SSM Parameter Store** with encryption. |
| **Reliability / Error Handling** | 1. Step Functions do not define **catch** blocks for Lambda failures. | Workflow may fail silently, causing lost events. | Add `addCatch` with a fallback state (e.g., send to DLQ, alert). |
| | 2. Lambda `timeout` values are modest but may be insufficient for heavy LLM calls. | Potential timeout errors under load. | Consider configurable timeout and monitor via CloudWatch metrics. |
| **Observability** | 1. No **metrics** or **alarms** for critical resources (DynamoDB throttling, Lambda errors, Step Functions failures). | Hard to detect production issues quickly. | Add CloudWatch Alarms for `ConsumedReadCapacityUnits`, Lambda `Errors`, and Step Functions `Failed`. |
| | 2. API Gateway lacks **access logging** and **request throttling** beyond default method options. | Limited insight into traffic patterns. | Enable `accessLogDestination` with a LogGroup and configure `methodSettings` for detailed throttling. |
| **Maintainability** | 1. Hard‑coded strings for resource names (`FlightPulseTable`, `flightpulse-bus`, etc.). | Refactoring or renaming becomes error‑prone. | Use CDK **`CfnParameter`** or **`cdk.Stack.of(this).stackName`** for naming conventions. |
| | 2. Repeated Lambda bundling commands for Node.js functions. | Duplication increases maintenance burden. | Extract bundling config into a reusable **function** or **construct**. |
| **Performance / Cost** | 1. DynamoDB table uses **PAY_PER_REQUEST** billing. | Good for variable traffic but may be costly at scale. | Evaluate provisioned capacity with auto‑scaling if traffic is predictable. |
| | 2. No **caching** layer for frequently accessed flight metadata. | Increased read load on DynamoDB. | Consider adding **DynamoDB DAX** or an **API Gateway cache** for GET endpoints. |
| **Best Practices** | 1. No **tags** applied to resources for cost allocation. | Hard to track spend per environment/project. | Apply common tags (`Project: FlightPulse`, `Environment: ${env}`) via CDK `Tags.of(this).add`. |
| | 2. No **construct tests** (unit tests) for the stack. | Risk of regression when modifying resources. | Add **cdk‑assert** tests (Jest) to validate resource properties. |

---

## 3. Implementation Plan
Below is a step‑by‑step plan. Each step includes a brief description, the files to edit/create, and the expected outcome.

### 3.1. Security Enhancements
1. **Scope Bedrock IAM policy** – Update `llmMessenger` role to reference the exact model ARN using a CloudFormation parameter.
2. **Add VPC configuration** – Create a VPC construct, attach Lambdas to private subnets, and add VPC endpoints for DynamoDB, EventBridge, and Bedrock.
3. **Parameterize removal policy** – Introduce a context variable `removalPolicy` (default `RETAIN`) and use it when creating the table.
4. **Store model ID securely** – Move `BEDROCK_MODEL_ID` to SSM Parameter Store (secure string) and read it in the Lambda via environment variable.

### 3.2. Reliability & Error Handling
5. **Add catch blocks** to all Step Functions tasks (`LambdaInvoke`, `DynamoDB*`) directing failures to a `NotifyFailure` state that publishes to an SNS topic.
6. **Increase Lambda timeout** for `llmMessenger` to 120 s (configurable) and add a CloudWatch alarm for timeout errors.

### 3.3. Observability & Monitoring
7. **Create CloudWatch Alarms** for DynamoDB read/write throttling, Lambda error count, and Step Functions failures.
8. **Enable API Gateway access logs** – Define a LogGroup and set `accessLogDestination` and `accessLogFormat`.
9. **Tag all resources** – Apply standard tags using `Tags.of(this).add` in the stack constructor.

### 3.4. Maintainability Improvements
10. **Extract common bundling config** into a helper function `nodejsBundlingConfig()` and reuse for `apiHandlers` and `streamHandler`.
11. **Replace hard‑coded names** with parameters (e.g., `tableName`, `busName`).
12. **Add CDK unit tests** – Create `test/flightpulse-stack.test.ts` using `aws-cdk-lib/assertions` to verify key resources.

### 3.5. Performance & Cost Optimizations
13. **Evaluate DynamoDB billing mode** – Add a context flag to switch between `PAY_PER_REQUEST` and provisioned with auto‑scaling.
14. **Introduce caching** – Add an API Gateway cache for the `GET /flights` endpoint (TTL 60 s).

### 3.6. Documentation & CI/CD
15. **Update README** with architecture diagram and deployment steps.
16. **Add GitHub Actions workflow** to run `cdk synth`, `cdk diff`, and the unit tests on PRs.

---

## 4. Next Steps
- Review the plan with the team and prioritize items (security fixes first).
- Create a feature branch (e.g., `feature/security‑enhancements`).
- Implement steps 1‑4, run `cdk synth` and `cdk deploy --require-approval never` in a sandbox account.
- Iterate through the remaining steps, adding tests and CI as you go.

---

*Prepared by Antigravity – your AI‑powered coding assistant.*
