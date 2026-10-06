# Kanakku AWS Cloud Deployment Architecture Guide (Phase 7)

## 1. Executive Summary & Production Topology

Kanakku is deployed on **Amazon Web Services (AWS)** using a serverless container architecture tailored for multi-tenant Indian SMB accounting workloads. The infrastructure combines **AWS App Runner** for managed container orchestration, **Amazon RDS for PostgreSQL 16** for ACID-compliant double-entry ledger persistence, **AWS Secrets Manager** for credential security, **Amazon Bedrock** for intelligent conversational intent parsing, and **Amazon CloudWatch Logs** for external tamper-evident audit anchoring.

```
                              Internet / Browser
                                      │
                     HTTPS / TLS (443)│
                                      ▼
               ┌──────────────────────────────────────────────┐
               │              AWS App Runner                  │
               │                                              │
               │  ┌────────────────────┐ ┌──────────────────┐ │
               │  │   kanakku-console  │ │kanakku-mcp-server│ │
               │  │  (Next.js 15, :3000│ │ (Streamable HTTP,│ │
               │  │  Health: /api/heal)│ │  Health: /health)│ │
               │  └─────────┬──────────┘ └─────────┬────────┘ │
               └────────────┼──────────────────────┼──────────┘
                            │                      │
                   App Runner VPC Connector        │
                            │                      │
         ┌──────────────────▼──────────────────────▼──────────────────┐
         │             AWS Virtual Private Cloud (VPC)                │
         │                                                            │
         │  Public Subnets (NAT Gateway + Internet Gateway)           │
         │                                                            │
         │  Private Subnets (Dual-AZ: ap-south-1a / ap-south-1b)      │
         │   • Egress via NAT Gateway / VPC Endpoints                 │
         │                                                            │
         │  ┌──────────────────────────────────────────────────────┐  │
         │  │           Amazon RDS PostgreSQL 16 (Multi-AZ)        │  │
         │  │   • Port: 5432 (Ingress strictly from VPC Connector) │  │
         │  │   • Encrypted storage via AWS KMS                    │  │
         │  │   • 3-month deterministic seed & migrations          │  │
         │  └──────────────────────────────────────────────────────┘  │
         │                                                            │
         │  AWS PrivateLink VPC Endpoints:                            │
         │   ├── AWS Secrets Manager (Credentials: DATABASE_URL)     │
         │   ├── Amazon Bedrock (Converse API: Claude 3.5 Sonnet)     │
         │   └── Amazon CloudWatch Logs (Audit Trail Anchors)         │
         └────────────────────────────────────────────────────────────┘
```

---

## 2. Containerization Strategy (`infra/docker/`)

### 2.1. Multi-Stage Builds & Monorepo Optimization

The repository uses pnpm workspaces. Separate multi-stage Dockerfiles isolate build-time compilers from the lean production runtime:

| Container | Base Image | Port | Health Check | Entrypoint |
|:---|:---|:---:|:---|:---|
| **`kanakku-mcp-server`** | `node:22-alpine` | `3001` | `GET /health` | `node packages/mcp-server/dist/index.js` |
| **`kanakku-console`** | `node:22-alpine` | `3000` | `GET /api/health` | `next start --port 3000` |

### 2.2. Package Distribution & Entrypoint Resolution
- Both `@kanakku/core` and `@kanakku/db` are compiled to `./dist` during the builder stage.
- The production runner stages explicitly copy `./packages/db/dist` (along with `@kanakku/core/dist`), allowing Node.js to resolve package export maps (`"." -> "./dist/index.js"`).
- Non-root execution runs under unprivileged system users (`kanakku:1001` and `nextjs:1001`).

---

## 3. AWS App Runner & Networking Architecture

### 3.1. Image-Based Deployment vs `apprunner.yaml`
- **Important**: AWS App Runner `apprunner.yaml` files are exclusively for source-code deployments from GitHub. For pre-built container images stored in Amazon ECR, App Runner services are provisioned via:
  1. **Terraform**: Resources `aws_apprunner_service.mcp_server` and `aws_apprunner_service.console` in [`infra/terraform/main.tf`](file:///c:/kanakku/infra/terraform/main.tf).
  2. **AWS CLI Input JSON**: [`infra/apprunner/mcp-server-service-input.json`](file:///c:/kanakku/infra/apprunner/mcp-server-service-input.json) and [`infra/apprunner/console-service-input.json`](file:///c:/kanakku/infra/apprunner/console-service-input.json) via `aws apprunner create-service --cli-input-json file://...`.

### 3.2. VPC Egress & Connectivity
- When App Runner connects to private VPC subnets via `aws_apprunner_vpc_connector.rds_connector`, all egress traffic is directed into the VPC.
- To prevent connectivity blackholes to public APIs or AWS endpoints:
  - **NAT Gateway & Internet Gateway**: Public subnets host an AWS NAT Gateway so egress traffic can reach external endpoints.
  - **AWS PrivateLink VPC Endpoints**: Interface endpoints for `secretsmanager`, `logs`, and `bedrock-runtime` route AWS API calls directly over the AWS private backbone.

### 3.3. Service-to-Service Communication
- The Console connects to the MCP Server via its authentic App Runner HTTPS URL: `https://${aws_apprunner_service.mcp_server.service_url}`.
- Communication is secured via Bearer token authentication and tenant headers (`X-Tenant-Key`).

---

## 4. Amazon RDS PostgreSQL 16 & Secrets Manager

### 4.1. Database Configuration
- **Engine**: PostgreSQL 16.2 on AWS Graviton (`db.t4g.medium`).
- **High Availability**: Multi-AZ standby replica with automatic failover.
- **Security Group Ingress**: Port 5432 ingress is locked exclusively to the security group of the App Runner VPC Connector (`aws_security_group.apprunner_connector_sg`).
- **Storage Encryption**: AES-256 encryption at rest managed by AWS KMS.

### 4.2. Secrets Manager Integration & Least-Privilege Role Separation
- **Runtime Application User (`kanakku_app`)**:  
  Runtime containers (MCP server and Web Console) connect using a dedicated least-privilege database user `kanakku_app` provisioned via [`infra/db/init-runtime-user.sql`](file:///c:/kanakku/infra/db/init-runtime-user.sql). This user possesses strictly DML permissions (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) on application tables and `USAGE` on sequences. It has zero DDL permissions (cannot drop, alter, or truncate tables).
- **Dedicated Plain URL Secret (`kanakku/${var.environment}/database-url`)**:  
  Contains the raw PostgreSQL connection string URL for the runtime user:  
  `postgresql://kanakku_app:<password>@<endpoint>:5432/kanakkudb?sslmode=require`  
  The password is URL-encoded (`urlencode()`) with safe character sets (`!-_=+.`). AWS App Runner injects this secret directly into `process.env.DATABASE_URL` at container startup.
- **Administrative Credentials Secret (`kanakku/${var.environment}/database-admin-credentials`)**:  
  Contains structured JSON for the RDS master user `kanakku_admin` for executing schema migrations and maintenance. **App Runner container IAM policies are strictly blocked from accessing this secret.**
- **Audit Anchor Secret (`kanakku/${var.environment}/audit-anchor-secret`)**:  
  A random 48-character cryptographic HMAC-SHA256 signing secret for CloudWatch audit trail anchoring.
- **Credential Hygiene & One-Time Display**:  
  Operator keys are never stored in git. Local development and production keys can be rotated at any time using `pnpm --filter @kanakku/db db:rotate-key`, which outputs generated keys once to the operator's secure terminal or accepts a custom secret via `NEW_API_KEY`. Seed scripts never print plaintext secrets.

---

## 5. Amazon Bedrock Converse API Integration

### 5.1. IAM Instance Roles & Least Privilege
The console container assumes an IAM instance role (`KanakkuConsoleInstanceRole`) with permissions limited strictly to conversational model execution:
```json
{
  "Effect": "Allow",
  "Action": [
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream"
  ],
  "Resource": [
    "arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-sonnet-*",
    "arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-haiku-*"
  ]
}
```

### 5.2. Deterministic Intent Fallback
In accordance with Kanakku ADR-002:
- If Bedrock Converse credentials are not configured or encounter temporary throttling/network interruptions, the orchestrator gracefully falls back to the internal regex-based deterministic intent engine without dropping user voice sessions.

---

## 6. Audit Trail Anchoring & Compliance Immutability (ADR-005)

### 6.1. Operational Anchoring vs Regulatory WORM Storage
As specified in [ADR-005](file:///c:/kanakku/docs/adr/ADR-005-double-entry-ledger-and-audit.md), an internal cryptographic hash chain protects against application-level tampering. To defend against a database administrator or superuser rewriting database rows and regenerating hashes, Kanakku anchors the latest `entry_hash` to external append-only storage:
- **Operational Log Sink (CloudWatch Logs)**:  
  CloudWatch Logs receives append-only structured audit anchor events with a 365-day event expiration policy. Note that CloudWatch retention defines an automated deletion lifecycle after 365 days.
- **Regulatory WORM Archive (Amazon S3 Object Lock)**:  
  For statutory compliance requiring non-rewritable, non-erasable records (e.g. Indian Companies Act 8-year statutory ledger retention or RBI/SEBI requirements), audit anchor streams can be exported or replicated to an **Amazon S3 bucket configured with Object Lock in Compliance Mode**. S3 Object Lock provides true Write-Once-Read-Many (WORM) immutability, ensuring that even AWS account root users cannot delete or alter records before the retention period expires.

### 6.2. Post-Commit Cryptographic Anchoring Flow & Transactional Outbox (ADR-005)
To prevent **phantom anchors** (external CloudWatch audit entries created for database transactions that subsequently abort or roll back) while guaranteeing 100% durable asynchronous recovery:
1. **In-Transaction Atomic Outbox Record**:
   - The month close, ledger locks, audit log entry, token consumption, and an `audit_anchor_outbox` record are written and committed in the **same atomic database transaction**.
   - If the transaction fails or rolls back, the outbox record rolls back as well (zero phantom anchors).
2. **Post-Commit Execution & Idempotency Cache Sync**:
   - Once the transaction is durably committed, [`processAuditAnchorOutboxItem`](file:///c:/kanakku/packages/mcp-server/src/audit/outbox.ts) attempts immediate dispatch to CloudWatch Logs using [`anchorAuditHead`](file:///c:/kanakku/packages/mcp-server/src/audit/anchor.ts).
   - Upon success: The outbox record is marked `status: 'anchored'`, and the stored `idempotencyRecords.responsePayload` is updated in the database. Any repeated client request returns the verified receipt rather than stale `pending`.
   - Upon transient failure: The outbox item remains in the database with `status: 'failed'`, `attempts: 1`, and `lastError`. The API response returns `status: 'pending_retry'`.
3. **Multi-Instance Concurrency Protection (`FOR UPDATE SKIP LOCKED`)**:
   - To safely run multiple horizontal MCP server instances or background workers without collision, [`claimAuditAnchorOutboxBatch`](file:///c:/kanakku/packages/mcp-server/src/audit/outbox.ts) queries pending/failed rows using PostgreSQL's `FOR UPDATE SKIP LOCKED` and applies a 120-second `locked_until` lease.
   - Concurrent instances skip already-claimed rows without blocking or duplicate dispatches.
4. **Production Background Worker Wiring**:
   - The MCP server process automatically starts a background worker loop (`startAuditOutboxWorker`) on startup (polling every 30 seconds; configurable via `AUDIT_OUTBOX_POLL_INTERVAL_MS` or disabled via `AUDIT_OUTBOX_WORKER_ENABLED=false`).
   - A standalone CLI runner is also available for scheduled triggers (e.g. AWS EventBridge / ECS task):
     ```bash
     # One-shot sweep
     pnpm --filter @kanakku/mcp-server outbox:sweep
     # Continuous background worker
     pnpm --filter @kanakku/mcp-server outbox:worker
     ```

---

## 7. Staged Deployment Runbook

App Runner requires container images to exist in Amazon ECR before service creation. Kanakku manages this cleanly through a 3-stage lifecycle:

### Stage 1: Provision Foundation Infrastructure & ECR Repositories
```bash
cd infra/terraform
terraform init

# Provision VPC, subnets, NAT Gateway, RDS PostgreSQL 16, Secrets Manager, and ECR repositories
# enable_apprunner_services defaults to false to avoid image bootstrap race conditions
terraform plan -out=tfplan
terraform apply tfplan

# Note the provisioned ECR repository URLs and Secrets ARNs from Terraform outputs:
# ecr_mcp_server_repository_url
# ecr_console_repository_url
# secrets_manager_db_url_secret_arn
# secrets_manager_db_admin_credentials_secret_arn
```

### Stage 1.5: Bootstrap Database Schema & Least-Privilege Runtime Role (`kanakku_app`)
Before starting application containers, initialize database tables and provision the `kanakku_app` user with the generated secret:
```bash
# Retrieve secrets from AWS Secrets Manager
ADMIN_DB_URL=$(aws secretsmanager get-secret-value --secret-id kanakku/production/database-admin-credentials --query SecretString --output text | jq -r .DATABASE_URL)
RUNTIME_DB_URL=$(aws secretsmanager get-secret-value --secret-id kanakku/production/database-url --query SecretString --output text)

# 1. Run schema migrations as administrator
DATABASE_URL="${ADMIN_DB_URL}" pnpm --filter @kanakku/db db:migrate

# 2. Provision least-privilege runtime role (kanakku_app) with Terraform-generated password
ADMIN_DATABASE_URL="${ADMIN_DB_URL}" APP_DATABASE_URL="${RUNTIME_DB_URL}" pnpm --filter @kanakku/db db:bootstrap-app-role
```

### Stage 2: Build & Push Production Containers to ECR
```bash
# Set your AWS Account ID and Region
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export AWS_REGION=ap-south-1

# Authenticate Docker to AWS ECR
aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com

# Build & push MCP Server
docker build -f infra/docker/Dockerfile.mcp-server -t ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/kanakku-mcp-server:latest .
docker push ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/kanakku-mcp-server:latest

# Build & push Console Web App
docker build -f infra/docker/Dockerfile.console -t ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/kanakku-console:latest .
docker push ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/kanakku-console:latest
```

### Stage 3: Provision & Verify App Runner Services
Now that images exist in ECR and the `kanakku_app` database user is provisioned, deploy App Runner services via Terraform:
```bash
cd infra/terraform
terraform apply -var="enable_apprunner_services=true"

# Alternatively, deploy using the pre-configured AWS CLI input templates:
# aws apprunner create-service --cli-input-json file://infra/apprunner/mcp-server-service-input.json
# aws apprunner create-service --cli-input-json file://infra/apprunner/console-service-input.json

# Retrieve Service URLs and verify health endpoints
curl -f https://<mcp-service-domain>.awsapprunner.com/health
curl -f https://<console-service-domain>.awsapprunner.com/api/health
```
