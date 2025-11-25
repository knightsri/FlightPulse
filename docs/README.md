# FlightPulse Documentation

Welcome to the FlightPulse documentation! This folder contains all technical documentation for the FlightPulse serverless flight operations system.

## 📚 Documentation Index

### Architecture & Specifications
- **[FlightPulse Specification](./flightpulse-spec.md)** - Complete system specification, architecture, and data model
- **[Implementation Plan](./implementation-plan.md)** - Step-by-step plan for building the system with priorities and estimates

### Code Review & Quality
- **[Code Review](./CODE_REVIEW.md)** - Comprehensive code review findings and recommendations

### Security Documentation
- **[Security Enhancements](./SECURITY_ENHANCEMENTS.md)** - Initial security improvements (removal policy, IAM scoping, timeouts)
- **[VPC & SSM Security](./VPC_SSM_SECURITY.md)** - VPC architecture, SSM Parameter Store setup, and migration guide

---

## 🏗️ Project Structure

```
FlightPulse/
├── docs/                          # 📚 All documentation (you are here)
│   ├── README.md                  # This file
│   ├── flightpulse-spec.md        # System specification
│   ├── implementation-plan.md     # Build plan & roadmap
│   ├── CODE_REVIEW.md             # Code review findings
│   ├── SECURITY_ENHANCEMENTS.md   # Security improvements (phase 1)
│   └── VPC_SSM_SECURITY.md        # VPC & SSM setup (phase 2)
│
├── infrastructure/                # AWS CDK infrastructure
│   ├── bin/                       # CDK app entry point
│   ├── lib/                       # Stack & construct definitions
│   │   ├── flightpulse-stack.ts   # Main stack
│   │   └── network-construct.ts   # VPC & networking
│   └── test/                      # CDK tests
│
├── lambdas/                       # Lambda function code
│   ├── python/                    # Python Lambdas
│   │   ├── kafka-consumer/        # Ingests flight events
│   │   └── llm-messenger/         # Generates AI messages
│   └── nodejs/                    # Node.js Lambdas
│       ├── api-handlers/          # REST API handlers
│       └── stream-handler/        # DynamoDB stream processor
│
├── simulator/                     # Flight event simulator
└── scripts/                       # Deployment & setup scripts
```

---

## 🚀 Quick Start

### Prerequisites
- Node.js 20+
- AWS CDK CLI (`npm install -g aws-cdk`)
- AWS credentials configured
- Python 3.11+ (for Lambda development)

### Deploy Infrastructure
```bash
# Install dependencies
npm install

# Synthesize CloudFormation
npm run synth

# Deploy to AWS
npm run deploy
```

### Configuration
See `cdk.json` for context variables:
- `removalPolicy`: `"retain"` (prod) or `"destroy"` (dev)

---

## 🔐 Security Features

### Current Implementation
✅ **VPC Isolation** - All Lambdas run in private subnets with no internet access  
✅ **VPC Endpoints** - Direct connections to AWS services (no NAT gateway)  
✅ **SSM Parameter Store** - Secrets management for sensitive configuration  
✅ **Scoped IAM Policies** - Least-privilege access with region-specific ARNs  
✅ **Configurable Removal Policy** - Prevents accidental data loss in production  

### Architecture Diagram
See [VPC_SSM_SECURITY.md](./VPC_SSM_SECURITY.md#architecture) for detailed network diagram.

---

## 📖 Key Concepts

### Single Table Design
FlightPulse uses a single DynamoDB table with composite keys:
- **PK**: Entity type + ID (e.g., `FLIGHT#AA123`, `PASSENGER#P001`)
- **SK**: Relationship or metadata (e.g., `METADATA`, `BOOKING#B456`)
- **GSI1**: Status-based queries (flight delays, cancellations)
- **GSI2**: Booking status queries (rebooking workflows)

### Event-Driven Workflows
1. **Kafka Consumer** → Ingests flight events → DynamoDB
2. **DynamoDB Stream** → Triggers **Stream Handler** → EventBridge
3. **EventBridge Rules** → Route events → **Step Functions**
4. **Step Functions** → Orchestrate workflows:
   - Query affected bookings
   - Generate AI-powered messages via Bedrock
   - Send notifications (email, SMS)
   - Update flight/booking statuses

---

## 🧪 Testing

### Unit Tests (Coming Soon)
```bash
npm test
```

### Integration Tests
```bash
# Start local simulator
cd simulator
python producer.py --scenario delay

# Monitor events
aws logs tail /aws/lambda/LLMMessenger --follow
```

---

## 📊 Monitoring & Observability

### CloudWatch Dashboards
- Lambda execution metrics (duration, errors, throttles)
- DynamoDB capacity units & throttling
- Step Functions execution success/failure rates

### X-Ray Tracing
All Lambdas have active tracing enabled for end-to-end request tracking.

---

## 🤝 Contributing

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make changes & test locally
3. Run `npm run build` to check TypeScript compilation
4. Commit with descriptive messages (follow Conventional Commits)
5. Push and create a pull request

---

## 📝 License

This project is for demonstration purposes.

---

## 📞 Support

For questions or issues:
- Review the [Implementation Plan](./implementation-plan.md) for feature roadmap
- Check [Code Review](./CODE_REVIEW.md) for known issues
- See [VPC_SSM_SECURITY.md](./VPC_SSM_SECURITY.md) for security configuration

---

*Built with ❤️ using AWS CDK, Bedrock, and Step Functions*
