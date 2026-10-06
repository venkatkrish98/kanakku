# 📋 Devpost Submission Kit — Kanakku (கணக்கு)

Use this copy-paste ready guide to submit **Kanakku** on the official Devpost portal.

---

### 1. Basic Project Info
- **Project Title:**
  `Kanakku (கணக்கு) — Voice-First AI Bookkeeper for Indian MSMEs`
- **Elevator Pitch / Tagline (Under 200 chars):**
  `Voice-first financial OS and self-hosted MCP server bringing institutional double-entry bookkeeping to Indian small businesses with pure paise math & AWS safety guardrails.`
- **Primary Track:**
  `Alexa+ (Model Context Protocol / Agentic AI)`
- **Mini-Challenge:**
  `AWS Builder`
- **GitHub Repository URL:**
  `https://github.com/venkatkrish98/kanakku`

---

### 2. Demo Video (Video Link)
- **YouTube Video URL:**
  `https://youtu.be/57xZQnxHf50`
- **Duration:** 80 seconds (HD 720p with synchronized audio narration)

---

### 3. Built With (Tags)
```
model-context-protocol, amazon-bedrock, aws-app-runner, amazon-rds, postgresql, amazon-cloudwatch, aws-secrets-manager, next.js, react, typescript, drizzle-orm, zod, terraform
```

---

### 4. Devpost Project Story

#### 💡 Inspiration
India is home to over 63 million Micro, Small, and Medium Enterprises (MSMEs) powering a third of the nation’s economy. Yet, bookkeeping remains exhausting: clunky desktop software, chaotic spreadsheets, and paper receipts lead to unrecorded cash transactions and severe GST penalties. Most modern invoice tools lack true double-entry integrity, creating out-of-balance ledgers. We asked: *Can a small shopkeeper or studio owner simply speak in everyday language to manage invoices, tax liabilities, and expenses, while maintaining the financial rigor of an enterprise ERP?* This question led to **Kanakku** (the Tamil word for *accounts* and *calculations*).

#### ⚙️ What It Does
Kanakku is a voice-first, agentic financial operating system and self-hosted Model Context Protocol (MCP) server designed specifically for Indian SMBs:
1. **Conversational Invoicing & GST Math:** Generates compliant GST invoices with automated 9% CGST and 9% SGST splits using pure integer-paise math (zero floating-point drift).
2. **Interactive MCP Approval Cards (`ui://`):** Uses the MCP Apps extension to render interactive visual cards for draft invoices, payment reminders, and monthly summaries directly in the conversational stream.
3. **Draft -> Confirm -> Execute Safety:** Financial ledger entries are never created immediately. The engine issues a single-use HMAC token that requires human confirmation before touching the books.
4. **Daily Business Briefings:** Canonical MCP tools (`get_business_briefing`, `cashflow_summary`, `gst_liability`) proactively report overdue receivables and highlight expense surge anomalies.
5. **Month-End Close State Machine:** Resumable state machine (`scan` -> `categorise` -> `reconcile` -> `prepare_close`) that closes periods and locks books against backdated postings.

#### 🛠️ How We Built It
- **Model Context Protocol (MCP):** Implemented a self-hosted MCP server adhering to the `2025-11-25` Streamable HTTP specification (`@modelcontextprotocol/sdk`). It registers 13 canonical financial tools, 5 tenant resources, and 8 interactive MCP App cards.
- **Amazon Bedrock Converse:** Routes conversational intents using Anthropic Claude 3.5 Sonnet (`anthropic.claude-3-5-sonnet-20241022-v2:0`) with tool-calling fallback to a deterministic offline engine.
- **Amazon RDS PostgreSQL 16 & Drizzle ORM:** Institutional double-entry general ledger storing all currencies in integer paise with row-level locking (`FOR UPDATE SKIP LOCKED`).
- **Amazon CloudWatch Logs & Audit Outbox:** Append-only operational audit sink where serialized SHA-256 hash chains of closed periods are anchored with a transactional outbox worker.
- **AWS App Runner & Secrets Manager:** Serverless container deployment with automated SSL, private VPC egress, and encrypted secrets rotation.

#### 🧗 Challenges We Ran Into
1. **MCP Streamable HTTP Session Multiplexing:** Early implementations failed when clients dispatched tool calls before completing the session initialization handshake. We implemented automatic session recovery and session-id tracking.
2. **Float Drift in Tax Math:** Standard JavaScript `Number` introduces rounding errors in multi-item GST calculations. We strictly enforced integer BigInt paise across all calculations (ADR-002).
3. **Concurrent Background Workers:** Preventing duplicate audit anchor processing required implementing `FOR UPDATE SKIP LOCKED` batch claiming with exponential backoff.

#### 🏆 Accomplishments That We're Proud Of
- 100% test coverage across 218 unit and integration tests verifying all accounting invariants.
- Strict two-phase mutation safety that guarantees no AI hallucination can corrupt accounting records.
- Seamless voice-to-ledger workflow taking under 5 seconds from spoken request to balanced double-entry ledger entry.

#### 📚 What We Learned
We gained deep expertise in the Model Context Protocol (MCP) specification `2025-11-25`, Amazon Bedrock Converse multi-turn tool calling, and designing conversational interfaces that demand strict human-in-the-loop validation for financial data.

#### 🔮 What's Next For Kanakku
- Native WhatsApp business bot integration using the same self-hosted MCP server.
- Multi-lingual voice support for Tamil, Hindi, Telugu, and Kannada.
- Direct GSTN (GST Network) API integration for automated e-invoicing and GSTR-1 return filing.
