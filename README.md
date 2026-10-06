# Kanakku (கணக்கு) — Voice-First AI Financial Operating System for Indian MSMEs

> **Amazon Developer Hackathon 2026 — Build, Ship, Shape**  
> **Primary Track:** Alexa+ (Model Context Protocol / Agentic AI)  
> **Mini Challenge:** AWS Builder  

---

## 1. Project Overview

### 1.1. The Human Problem
India is home to over 63 million Micro, Small, and Medium Enterprises (MSMEs) powering nearly 30% of the nation's GDP. Yet, small business owners spend dozens of hours every month wrestling with rigid, desktop-bound accounting software or paper ledgers. Traditional accounting tools require extensive manual data entry, complex GST calculation rules (CGST, SGST, IGST set-offs), and constant reconciliation. Worse, most lightweight invoice apps lack true double-entry accounting integrity, leading to unjournaled transactions, out-of-balance ledgers, and catastrophic audit penalties.

### 1.2. The Solution: Kanakku (கணக்கு)
Named after the Tamil word for *accounts* and *calculations* (**கணக்கு**), **Kanakku** is a voice-first, agentic financial operating system designed for Indian MSMEs. Business owners can manage their entire accounting lifecycle using natural spoken language:
- *"Create an invoice for Apex Labs for 50,000 rupees plus 18% GST due in 15 days."*
- *"Record a travel expense of 3,200 rupees paid via UPI for client visit."*
- *"Give me a business briefing and cashflow comparison against last month."*
- *"Scan, reconcile, and close books for October 2026."*

Kanakku bridges conversational simplicity with institutional financial rigor:
1. **Deterministic Domain Engine**: LLMs only narrate and parse intent; all currency math is calculated deterministically in pure TypeScript using integer **paise** (1 INR = 100 paise) to eliminate floating-point rounding errors (ADR-002).
2. **Draft -> Confirm -> Execute Mutation Safety**: Mutations never execute immediately. Kanakku creates a signed draft, renders an interactive visual preview card, and requires explicit user confirmation before touching the ledger (ADR-003, ADR-004).
3. **Double-Entry General Ledger**: Every financial transaction generates balanced debit and credit journal lines adhering to standard Indian accounting standards.
4. **Cryptographic Audit Anchoring**: Closed periods are locked against backdated postings, and a serialized SHA-256 hash chain is anchored to **Amazon CloudWatch Logs** with a durable transactional outbox (ADR-005).

---

## 2. Track & Required Tool: Model Context Protocol (MCP)

Kanakku is built from the ground up on the **Model Context Protocol (MCP)**, the foundational standard for the **Alexa+ Track**:

### 2.1. Self-Hosted MCP Server (`@modelcontextprotocol/sdk`)
- **Transport**: **Streamable HTTP** (`/mcp`) adhering to MCP specification version `2025-11-25`.
- **Session Multiplexing**: Stateful multi-turn agent sessions managed via `mcp-session-id` headers.
- **13 Canonical Financial Tools**:
  1. `create_invoice`: Generates GST-compliant draft invoices with auto-detected inter-state/intra-state tax rates.
  2. `record_expense`: Categorizes expenses and links them to the Chart of Accounts with ITC eligibility checks.
  3. `send_reminder`: Drafts personalized WhatsApp/email payment reminder messages with tone controls (`polite` vs `firm`).
  4. `gst_liability`: Calculates net GST payable (Output GST minus Input Tax Credit) with statutory set-off ordering.
  5. `outstanding_invoices`: Inspects aging accounts receivable, overdue invoices, and customer balances.
  6. `cashflow_summary`: Aggregates cash inflows, operating outflows, and period comparisons.
  7. `get_business_briefing`: Comprehensive executive briefing on sales, pending receivables, and burn rate.
  8. `whats_changed_since`: Differential audit comparison since any baseline date.
  9. `explain_transaction`: Plain-English and double-entry explanation of any journal entry or transaction.
  10. `get_audit_history`: Verifies internal cryptographic hash chain integrity and external anchor status.
  11. `close_month`: Multi-step resumable state machine (`scan` -> `categorise` -> `reconcile` -> `prepare_close`).
  12. `confirm_action`: Consumes single-use confirmation tokens to atomically execute verified drafts.
  13. `cancel_action`: Explicitly discards pending drafts.
- **5 Live Resources**:
  - `gst://status`: Real-time GST liability summary.
  - `ledger://trial-balance`: Real-time balanced debit/credit trial balance.
  - `audit://chain-health`: Cryptographic hash chain validation status.
  - `session://context`: Multi-turn conversational context and active business memory.
  - `ui://templates/*`: Dynamic visual confirmation cards.
- **3 Structured Workflow Prompts**:
  - `month_end_close`: Multi-step guided month-end closing workflow.
  - `weekly_briefing`: Weekly operational briefing for owners.
  - `business_briefing`: Comprehensive financial health check.

### 2.2. Interactive MCP Apps Extension (`@modelcontextprotocol/ext-apps`)
Kanakku implements the new **MCP Apps (`ui://`) extension**. When the client negotiates UI capabilities, the MCP server serves interactive HTML/CSS cards (`text/html;profile=mcp-app`):
- **Invoice Card**: Displays line items, HSN codes, and tax breakdowns with an interactive **Approve & Issue** button.
- **Month-End Close Card**: Interactive reconciliation checklist displaying unjournaled transactions, GST set-off balances, and period lock warnings.
- **Fallback Compatibility**: For voice-only clients (e.g. smart speakers), the server returns clean, concise spoken summaries.

### 2.3. Alexa+ Track Alignment & Architecture Disclosure
Per official Devpost guidance and FAQs, developer tooling for unreleased native Alexa+ is not accessible to hackathon participants. To strictly fulfill the **Alexa+ Track** requirements:
- Kanakku implements a fully compliant, production-grade **Self-Hosted Model Context Protocol (MCP) Server** over Streamable HTTP (`/mcp`), ready to connect to any MCP-compliant agent host.
- We pair this with an interactive **Alexa+ Experience Simulator** (`/voice`) in the Next.js console, featuring Indian English speech-to-text (`en-IN`), real-time audio waveform visualizers, Amazon Bedrock Converse multi-turn intent routing, and live rendering of interactive MCP App approval cards.
- Kanakku does *not* claim native access to unreleased private Alexa+ developer toolkits; it demonstrates the exact agentic MCP architecture intended for next-generation Alexa+ agent workflows.

---

## 3. AWS Cloud Architecture (AWS Builder Mini Challenge)

```
                       ┌──────────────────────────────────────────────┐
                       │          Client / Browser Runtime            │
                       │   (Push-to-Talk Web Speech Audio / UI)       │
                       └──────────────────────┬───────────────────────┘
                                              │ HTTPS
                                              ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │                              AWS App Runner Service 1                                  │
 │                      Next.js 15 Console & Alexa+ Simulator (/voice)                    │
 │               (Amazon Bedrock Converse Orchestrator + Deterministic Intent Fallback)   │
 └────────────────────────────────────────────┬───────────────────────────────────────────┘
                                              │ Internal HTTPS (Streamable HTTP)
                                              ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │                              AWS App Runner Service 2                                  │
 │                       Kanakku MCP Server (Port 3001, /mcp)                             │
 │           13 Financial Tools • 5 Resources • 3 Prompts • Background Outbox Worker      │
 └──────────────────────┬─────────────────────────────────────────┬───────────────────────┘
                        │ VPC Connector (Private Subnets)         │ HTTPS (AWS SDK v3)
                        ▼                                         ▼
 ┌────────────────────────────────────────────┐ ┌─────────────────────────────────────────┐
 │       Amazon RDS PostgreSQL 16 (Multi-AZ)  │ │      Amazon CloudWatch Logs Sink        │
 │  Dual-Entry General Ledger • Outbox Queue  │ │      Append-Only Audit Trail Anchor     │
 │  Least-Privilege User: kanakku_app         │ │      /kanakku/production/audit-anchors  │
 └────────────────────────────────────────────┘ └─────────────────────────────────────────┘
```

- **AWS App Runner**: Fully managed serverless container runtime hosting both the MCP Server and Next.js Web Console with zero server management, automatic SSL, and private VPC egress.
- **Amazon Bedrock Converse API**: Orchestrates conversational multi-turn sessions using Anthropic Claude 3.5 Sonnet (`anthropic.claude-3-5-sonnet-20241022-v2:0`) with streaming latency and strict zero data retention.
- **Amazon RDS for PostgreSQL 16**: Multi-AZ relational database providing ACID transaction guarantees, integer paise financial fields, and row-level locking (`FOR UPDATE SKIP LOCKED`) for background job workers.
- **AWS Secrets Manager**: Stores and rotates runtime database credentials (`DATABASE_URL`), RDS master administrative credentials, and cryptographic audit signing keys (`AUDIT_ANCHOR_SECRET`).
- **Amazon CloudWatch Logs**: Immutable append-only operational sink receiving HMAC-SHA256 signed audit head hashes upon month close.
- **Terraform**: 100% declarative Infrastructure-as-Code in [`infra/terraform`](file:///c:/kanakku/infra/terraform).

---

## 4. Built With

| Layer / Component | Technology / Product | Specific Role in Kanakku |
| :--- | :--- | :--- |
| **Agent Protocol** | **Model Context Protocol (MCP)** | Canonical tool and resource execution protocol (`@modelcontextprotocol/sdk` spec `2025-11-25`). |
| **Interactive UI** | **MCP Apps Extension** | Interactive visual approval cards served over `ui://` templates (`@modelcontextprotocol/ext-apps`). |
| **LLM Orchestration** | **Amazon Bedrock Converse API** | Intent classification and multi-turn conversational synthesis using Anthropic Claude 3.5 Sonnet. |
| **Container Compute** | **AWS App Runner** | Serverless container execution for MCP server and console web app. |
| **Database** | **Amazon RDS PostgreSQL 16** | Relational double-entry ledger, transaction outbox, and period locks. |
| **Audit Immutability** | **Amazon CloudWatch Logs** | Append-only external anchoring for cryptographic hash chain heads. |
| **Secrets & Keys** | **AWS Secrets Manager** | Dynamic injection of runtime connection strings and signing keys. |
| **Infrastructure as Code**| **Terraform (AWS Provider)** | Automated, reproducible cloud provisioning across VPC, RDS, and App Runner. |
| **Database ORM** | **Drizzle ORM** | Type-safe SQL schema, automated migrations, and integer paise BigInt mapping. |
| **Frontend Framework**| **Next.js 15 (App Router)** | Full-stack React console, streaming route handlers, and audio waveform visualizer. |
| **Speech Interface** | **Web Speech API** | Client-side Indian English speech-to-text (`en-IN`) and speech synthesis. |
| **Validation** | **Zod** | Strict runtime schema validation for financial tool inputs and parameters. |

---

## 5. Local Quickstart & Verification

### Prerequisites
- Node.js 22+
- pnpm 12.6.0+ (`corepack enable`)
- Docker & Docker Compose

### 1. Start Database & Run Migrations
```bash
# Start local PostgreSQL 16 container
docker compose up -d

# Run Drizzle migrations
pnpm --filter @kanakku/db db:migrate

# Seed realistic 3-month Indian SMB dataset (July - Sept 2026)
pnpm --filter @kanakku/db seed
```

### 2. Start Services
```bash
# Start MCP Server (Port 3001)
pnpm --filter @kanakku/mcp-server dev

# In a separate terminal, start Next.js Console & Voice Simulator (Port 3000)
pnpm --filter @kanakku/console dev
```

### 3. Verify Health Endpoints
- **MCP Server**: `http://localhost:3001/health`
- **Web Console**: `http://localhost:3000/api/health`
- **Interactive Voice Simulator**: `http://localhost:3000/voice`
- **Books Dashboard**: `http://localhost:3000/`

### 4. Live MCP Streamable HTTP Demo via curl
You can interact directly with the running MCP server over Streamable HTTP:

```bash
# 1. Initialize MCP Session
curl -i -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test-client","version":"1.0.0"}}}'

# Note the 'mcp-session-id' returned in headers (e.g. <SESSION_ID>)

# 2. List Available Financial Tools
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: <SESSION_ID>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3. Call 'gst_liability' Tool
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: <SESSION_ID>" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"gst_liability","arguments":{"period":"2026-10"}}}'
```

---

## 6. Testing & Quality Assurance

Kanakku includes a comprehensive automated test suite covering all accounting invariants, MCP Streamable HTTP protocols, AppBridge cards, and audit anchoring:

```bash
# Run all 218 unit and integration tests across the workspace
pnpm test

# Run strict TypeScript typecheck
pnpm typecheck
```

- **ADR-002 Invariants**: Verified that currency amounts are strictly stored in integer paise; verified zero floating-point drift across 10,000 randomized transactions.
- **Two-Phase Commit**: Verified that draft mutations cannot be executed without valid single-use confirmation tokens.
- **Period Locking**: Verified that expenses and invoices dated in closed calendar periods are strictly rejected (`PERIOD_CLOSED`).
- **Concurrent Outbox**: Verified that `claimAuditAnchorOutboxBatch` uses `FOR UPDATE SKIP LOCKED` so concurrent worker instances never process the same outbox item twice.

---

## 7. Submission Artifacts

- **Devpost Project Name**: Kanakku (கணக்கு) — Voice-First AI Bookkeeper for Indian MSMEs
- **Pitch Video Script & Shot List (2m 48s)**: [`docs/pitch-video-script.md`](file:///c:/kanakku/docs/pitch-video-script.md)
- **Developer & Platform Feedback**: [`FEEDBACK.md`](file:///c:/kanakku/FEEDBACK.md)
- **Friction Log**: [`FRICTION_LOG.md`](file:///c:/kanakku/FRICTION_LOG.md)
- **AWS Infrastructure Blueprint**: [`docs/aws.md`](file:///c:/kanakku/docs/aws.md)
- **Architecture Specification**: [`docs/architecture.md`](file:///c:/kanakku/docs/architecture.md)

---

## 8. License

This project is licensed under the MIT License — see the [`LICENSE`](file:///c:/kanakku/LICENSE) file for details.

