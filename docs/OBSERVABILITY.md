# Observability Enhancements

## Overview
This update adds comprehensive observability features including API Gateway access logging and resource tagging for cost allocation and operational visibility.

---

## ✅ 1. API Gateway Access Logging

### What Changed
Enabled **full request/response logging** for API Gateway with structured JSON logs sent to CloudWatch.

### Implementation

**CloudWatch LogGroup**:
```typescript
const apiAccessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
  logGroupName: '/aws/apigateway/flightpulse-api',
  retention: logs.RetentionDays.ONE_MONTH,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});
```

**API Gateway Deploy Options**:
```typescript
const api = new apigateway.RestApi(this, 'FlightPulseApi', {
  deployOptions: {
    accessLogDestination: new apigateway.LogGroupLogDestination(apiAccessLogGroup),
    accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
      caller: true,
      httpMethod: true,
      ip: true,
      protocol: true,
      requestTime: true,
      resourcePath: true,
      responseLength: true,
      status: true,
      user: true,
    }),
    loggingLevel: apigateway.MethodLoggingLevel.INFO,
    dataTraceEnabled: true,
    metricsEnabled: true,
  },
});
```

### Log Format
JSON structured logs include:
- **Caller** - AWS account/principal making the request
- **HTTP Method** - GET, POST, PUT, DELETE, etc.
- **IP Address** - Source IP of the request
- **Request Time** - ISO 8601 timestamp
- **Resource Path** - API endpoint (e.g., `/flights/{flightId}`)
- **Response Length** - Size in bytes
- **Status Code** - HTTP response code
- **User** - IAM user/role (if authenticated)

### Benefits
- ✅ **Traffic analysis** - Understand API usage patterns
- ✅ **Debugging** - Track down failed requests with full context
- ✅ **Security auditing** - Monitor access patterns and detect anomalies
- ✅ **Performance insights** - Identify slow endpoints
- ✅ **Compliance** - Meet audit log requirements

---

## ✅ 2. Resource Tagging

### What Changed
Applied **standardized tags** to all resources for cost allocation, organization, and automation.

### Tags Applied

| Tag Key | Tag Value | Purpose |
|---------|-----------|---------|
| **Project** | FlightPulse | Group all resources by project |
| **Environment** | dev/staging/prod | Separate environments for billing |
| **ManagedBy** | CDK | Identify infrastructure-as-code resources |
| **CostCenter** | Engineering | Allocate costs to business units |

### Implementation

```typescript
// Apply tags to entire stack
cdk.Tags.of(this).add('Project', 'FlightPulse');
cdk.Tags.of(this).add('Environment', environment);
cdk.Tags.of(this).add('ManagedBy', 'CDK');
cdk.Tags.of(this).add('CostCenter', 'Engineering');
```

**All resources inherit these tags**:
- Lambda functions
- DynamoDB tables
- VPC & subnets
- Security groups
- Step Functions state machines
- SNS topics
- SQS queues
- CloudWatch LogGroups
- API Gateway

### Benefits
- ✅ **Cost allocation** - Track spend by Project, Environment, or CostCenter
- ✅ **Resource discovery** - Filter resources in AWS Console by tags
- ✅ **Automation** - Target resources with AWS Systems Manager or scripts
- ✅ **Compliance** - Tag-based access policies (e.g., restrict prod access)
- ✅ **Multi-account** - Consistent tagging across AWS accounts

---

## 📊 Viewing Access Logs

### CloudWatch Logs Insights

**Query all API requests**:
```sql
fields @timestamp, httpMethod, resourcePath, status, ip
| sort @timestamp desc
| limit 100
```

**Query errors (4xx/5xx)**:
```sql
fields @timestamp, httpMethod, resourcePath, status, responseLength
| filter status >= 400
| sort @timestamp desc
```

**Query slow requests**:
```sql
fields @timestamp, httpMethod, resourcePath, status, responseTime
| filter responseTime > 1000
| sort responseTime desc
```

**Top endpoints by traffic**:
```sql
stats count() as requests by resourcePath
| sort requests desc
```

### Access Logs via AWS Console

1. Navigate to **CloudWatch → Log groups**
2. Select `/aws/apigateway/flightpulse-api`
3. Click **Search log group** or **Insights**
4. Run queries above or browse recent logs

---

## 💰 Cost Explorer with Tags

### View Costs by Tag

**AWS Console**:
1. Navigate to **AWS Cost Explorer**
2. Click **Cost Allocation Tags**
3. Activate tags: `Project`, `Environment`, `CostCenter`
4. Wait 24 hours for tags to appear in reports

**Filter costs**:
```
Filter by Tag → Project: FlightPulse
Group by → Environment
```

**Result**: See costs broken down by dev/staging/prod environments.

### AWS CLI Example

```bash
# Get costs for FlightPulse project (last 30 days)
aws ce get-cost-and-usage \
  --time-period Start=2025-01-01,End=2025-02-01 \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --group-by Type=TAG,Key=Project \
  --filter file://filter.json

# filter.json:
#  {
#    "Tags": {
#      "Key": "Project",
#      "Values": ["FlightPulse"]
#    }
#  }
```

---

## 🔧 Configuration

### Set Environment via CDK Context

**`cdk.json`**:
```json
{
  "context": {
    "environment": "dev",
    "removalPolicy": "retain"
  }
}
```

**Deploy to different environments**:
```bash
# Development
cdk deploy -c environment=dev

# Staging
cdk deploy -c environment=staging

# Production
cdk deploy -c environment=prod -c removalPolicy=retain
```

### Custom Tags

Add custom tags in the stack:
```typescript
cdk.Tags.of(this).add('Team', 'Platform');
cdk.Tags.of(this).add('Owner', 'ops-team@example.com');
cdk.Tags.of(this).add('Compliance', 'PCI-DSS');
```

---

## 📈 Monitoring Access Patterns

### CloudWatch Metrics (Enabled)

With `metricsEnabled: true`, API Gateway automatically publishes:

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| **4XXError** | Client errors | >5% of requests |
| **5XXError** | Server errors | >1% of requests |
| **Count** | Total requests | Baseline for capacity planning |
| **Latency** | Response time | p99 > 1000ms |
| **CacheHitCount** | Cache hits | (coming soon in Performance phase) |
| **CacheMissCount** | Cache misses | (coming soon) |

### Create Alarms for API Errors

```typescript
// In MonitoringConstruct (future enhancement)
const api4xxAlarm = new cloudwatch.Alarm(this, 'Api4xxErrors', {
  metric: api.metricClientError(),
  threshold: 10, // 10 client errors in 5 min
  evaluationPeriods: 1,
});

const api5xxAlarm = new cloudwatch.Alarm(this, 'Api5xxErrors', {
  metric: api.metricServerError(),
  threshold: 5, // 5 server errors in 5 min
  evaluationPeriods: 1,
});
```

---

## 🚨 Debugging Failed Requests

### Step-by-Step

1. **Check API Gateway access logs**:
   ```
   CloudWatch → /aws/apigateway/flightpulse-api
   Filter by status >= 400
   ```

2. **Identify failing endpoint**:
   ```json
   {
     "httpMethod": "GET",
     "resourcePath": "/flights/{flightId}",
     "status": 500,
     "ip": "1.2.3.4"
   }
   ```

3. **Check Lambda logs** (if 5xx error):
   ```
   CloudWatch → /aws/lambda/ApiHandlers
   Search for errors at the same timestamp
   ```

4. **Use X-Ray trace** (if available):
   ```
   X-Ray Console → Traces
   Filter by HTTP status = 500
   View service map for bottlenecks
   ```

---

## ✅ Observability Improvements Completed

| Enhancement | Status | Impact |
|-------------|--------|--------|
| **API Gateway access logs** | ✅ Complete | Full request/response logging |
| **JSON structured logging** | ✅ Complete | Easy querying with Logs Insights |
| **CloudWatch Metrics enabled** | ✅ Complete | Real-time API performance metrics |
| **Standard resource tags** | ✅ Complete | Cost allocation & resource discovery |
| **Environment-based tagging** | ✅ Complete | Separate dev/staging/prod costs |

---

## 🔜 Remaining Work (Maintainability & Performance)

With observability complete, remaining items:
- [ ] Extract bundling config helper (DRY code)
- [ ] Add CDK unit tests
- [ ] Evaluate DynamoDB billing mode
- [ ] Add API Gateway caching

---

## 📚 Best Practices

### Log Retention

| Environment | Retention Period | Rationale |
|-------------|-----------------|-----------|
| **Development** | 7 days | Short-term debugging only |
| **Staging** | 30 days | Pre-production validation |
| **Production** | 90+ days | Compliance, auditing, trend analysis |

**Update retention**:
```typescript
retention: environment === 'prod' 
  ? logs.RetentionDays.THREE_MONTHS 
  : logs.RetentionDays.ONE_MONTH,
```

### Tag Governance

**Required tags** (enforce with AWS Config):
- `Project` - All resources MUST have a project tag
- `Environment` - dev/staging/prod
- `ManagedBy` - Manual/CDK/Terraform

**Optional tags**:
- `Owner` - Email of team responsible
- `CostCenter` - For chargeback
- `Compliance` - PCI/HIPAA/SOC2

---

*Observability is the key to operational excellence! 👀*
