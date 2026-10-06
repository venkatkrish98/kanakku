# Developer & Platform Feedback — Amazon Developer Hackathon 2026

This document contains authentic, empirical developer feedback and friction logging for every tool, API, and SDK utilized in **Kanakku (கணக்கு)** for the **Alexa+ Track** and **AWS Builder Mini Challenge**.

---

## 1. Model Context Protocol (MCP) TypeScript SDK (`@modelcontextprotocol/sdk`)

- **What we used it for**:  
  Implemented a self-hosted financial MCP server exposing 13 canonical accounting tools (`create_invoice`, `record_expense`, `close_month`, `confirm_action`, `whats_changed_since`, etc.), 5 tenant-scoped canonical business resources (`kanakku://business-summary`, `kanakku://chart-of-accounts`, `kanakku://gst-rates`, `kanakku://audit-trail`, `kanakku://business-memory`), 8 interactive MCP App resources (`ui://cards/*`), and 3 structured workflow prompts over Streamable HTTP (`/mcp`) adhering to MCP specification `2025-11-25`.

- **What worked well**:
  - Clean TypeScript interfaces for `McpServer`, `ResourceTemplate`, and Zod-based tool parameter schemas.
  - The Streamable HTTP transport natively handles bidirectional JSON-RPC streaming, session multiplexing (`mcp-session-id`), and graceful disconnects over standard HTTP POST/GET streams.
  - Integration with the official MCP Inspector allowed rapid live debugging of tool invocations and schema validation.

- **What needs improvement**:
  - Handling uninitialized sessions over Streamable HTTP returns generic 400 errors without explicit machine-readable guidance on initialization state.
  - Standard container health check guidance is missing: orchestrators (like AWS App Runner) probe via HTTP GET, which fails on an unauthenticated `/mcp` route unless custom bypasses (e.g., a dedicated `/health` endpoint) are manually added.
  - TypeScript types for complex resource URI templates can become loose when matching multi-segment paths.

- **Onboarding experience from zero to hello world**:
  - Initial setup to first working tool call took approximately 35 minutes: 15 minutes to declare Zod tool schemas and business handlers, and 20 minutes to configure native Node.js HTTP server streaming (`node:http` `createServer`) with spec-compliant headers (`content-type: text/event-stream; charset=utf-8` and `mcp-session-id`). Once initialized, the JSON-RPC execution cycle was immediate and deterministic.

- **Whether we would build with it again and why**:
  - **Yes, absolutely.** MCP is rapidly becoming the universal standard for AI tool execution. Its separation of tool definitions, typed schemas, and resource URIs eliminates ad-hoc function-calling formats across LLM providers.

---

## 2. MCP Interactive Apps Extension (`@modelcontextprotocol/ext-apps`)

- **What we used it for**:  
  Constructed interactive visual confirmation cards (`ui://` resource templates) for invoices, GST liabilities, and month-end closes. These cards embed HTML/CSS approval interfaces into voice and web sessions while preserving fallback markdown text for voice-only clients.

- **What worked well**:
  - The capability negotiation mechanism allows the MCP client to declare UI support during handshake, allowing the server to dynamically offer rich visual cards.
  - Sandboxed iframe communication via `AppBridge` protocol allows secure, two-way message passing between client and embedded card.

- **What needs improvement**:
  - Documentation and official starter templates for custom HTML card builders are scarce; styling guidelines across diverse hosts (desktop vs mobile web) require extensive trial and error.
  - Complex nested serialization inside iframe postMessage channels requires manual defensive sanitization.

- **Onboarding experience from zero to hello world**:
  - Moderate learning curve due to nascent ecosystem documentation. Required inspecting the official test harness to understand the `AppBridge` contract and approximately 2 hours of trial-and-error debugging with the iframe bridge. Specifically, debugging postMessage event serialization and styling across desktop and mobile containers required writing custom mock harnesses before cards rendered cleanly.

- **Whether we would build with it again and why**:
  - **Yes.** Interactive visual cards transform voice-only chatbots into multi-modal agent experiences, which is essential for high-stakes financial operations where users must inspect line items before approval.

---

## 3. Amazon Bedrock Converse API (`@aws-sdk/client-bedrock-runtime`)

- **What we used it for**:  
  Multi-turn conversational orchestration in the web console (`/voice`), intent classification, natural language entity extraction (rupees, paise, vendor names, GSTINs), and natural language voice summary generation using Anthropic Claude 3.5 Sonnet (`anthropic.claude-3-5-sonnet-20241022-v2:0`).

- **What worked well**:
  - The Converse API (`ConverseCommand`) provides a unified multi-turn schema that eliminates provider-specific payload idiosyncrasies.
  - Exceptional accuracy extracting complex Indian financial terms (e.g., "5000 rupees plus 18% GST for catering", "inter-state IGST", "TDS deduction").
  - Multi-turn tool calling performed reliably across our tested voice interaction flows, providing responsive dialog turns though response times vary based on payload complexity and network conditions.

- **What needs improvement**:
  - In `@aws-sdk/client-bedrock-runtime`, the TypeScript `Tool` union expects internal `$unknown` variants, requiring type casting (`as unknown as Tool[]`) when passing external tool schemas.
  - Rate limiting and throttling exceptions (ThrottlingException) could benefit from higher default SDK retry backoffs in low-quota sandbox accounts.

- **Onboarding experience from zero to hello world**:
  - Model access for Anthropic Claude 3.5 Sonnet in `ap-south-1` was requested and approved in the AWS Console Model Access panel within 5 minutes. Once activated, configuring the Converse API with AWS SDK v3 took under 20 minutes to achieve working multi-turn voice dialog.

- **Whether we would build with it again and why**:
  - **Yes.** Bedrock Converse is enterprise-ready and provides unified multi-turn schema support; per AWS documentation, customer prompts and completions are not used to train AWS foundation models. Teams can configure account-level logging, data retention policies, and regional inference boundaries to match specific compliance requirements.

---

## 4. Amazon CloudWatch Logs SDK (`@aws-sdk/client-cloudwatch-logs`)

- **What we used it for**:  
  External tamper-evident audit trail anchoring (ADR-005). Every closed financial month and locked ledger is cryptographically bound into an HMAC-SHA256 signature and anchored into an append-only CloudWatch Log Group (`/kanakku/production/audit-anchors`).

- **What worked well**:
  - High write throughput, millisecond ingestion latency, and predictable AWS IAM resource scoping.
  - Standard 365-day log retention policies provide out-of-the-box operational lifecycle management.

- **What needs improvement**:
  - IAM resource ARN syntax for log streams is strict: permissions for `CreateLogStream` and `PutLogEvents` fail with 403 AccessDenied unless the ARN specifically ends with `:*` (e.g., `arn:aws:logs:*:*:log-group:/kanakku/*:*`).
  - Sequence token management in older PutLogEvents APIs was notoriously painful; while newer SDK versions relax sequence token requirements, documentation could be clearer on concurrent writes to the same stream.

- **Onboarding experience from zero to hello world**:
  - Simple zero-to-hello-world setup: created a log group and sent structured JSON events within 10 lines of code.

- **Whether we would build with it again and why**:
  - **Yes.** CloudWatch Logs provides a durable, serverless, append-only operational audit sink with a 365-day retention lifecycle without the operational overhead of running dedicated log servers.

---

## 5. AWS App Runner (`aws_apprunner_service`)

- **What we used it for**:  
  Managed serverless container runtime hosting both the Kanakku MCP Server (port 3001) and Next.js 15 Console (port 3000), connected to Amazon RDS via VPC Connector.

- **What worked well**:
  - True serverless container execution: zero cluster management (unlike ECS/EKS), automatic SSL termination, and seamless horizontal auto-scaling.
  - Direct integration with AWS Secrets Manager (`environment_secrets`) securely injects database credentials at container start.
  - VPC Connector allowed private, encrypted database connectivity to RDS without exposing PostgreSQL port 5432 to the public internet.

- **What needs improvement**:
  - Initial service provisioning and image rollout can take 4-7 minutes per revision, which is slow compared to Lambda or ECS Fargate deployments.
  - Lack of multi-port container support: each App Runner service only exposes a single port, requiring separate services for the MCP server and Web console.

- **Onboarding experience from zero to hello world**:
  - ECR image push to running service was straightforward via Terraform. Initial setup required approximately 45 minutes to debug VPC Connector and private subnet routing so App Runner could resolve RDS without public ingress. Staged deployment ordering was necessary to push ECR images before provisioning the services.

- **Whether we would build with it again and why**:
  - **Yes.** For standalone HTTP and Streamable HTTP microservices, App Runner delivers production-grade resilience with minimal DevOps overhead.

---

## 6. Amazon RDS for PostgreSQL 16 & Drizzle ORM (`drizzle-orm`)

- **What we used it for**:  
  Multi-tenant double-entry accounting persistence, period locking, idempotency cache, transactional outbox queue, and hash-chained audit logs.

- **What worked well**:
  - Native PostgreSQL 16 row-level locking (`FOR UPDATE SKIP LOCKED`) enabled a robust, zero-collision concurrent transactional outbox worker.
  - Drizzle ORM offers near-zero runtime overhead, full type safety, and clean migration generation (`drizzle-kit generate`).
  - Native BigInt mode accurately stores all monetary values in integer paise, preventing floating-point rounding errors.

- **What needs improvement**:
  - Drizzle composite foreign key declarations require `unique()` instead of `uniqueIndex()` to be recognized by PostgreSQL as valid foreign key targets.
  - Drizzle migrations do not automatically copy SQL migration files to build output (`dist/`) in monorepos; required adding a post-build copy step.

- **Onboarding experience from zero to hello world**:
  - Local Docker Compose PostgreSQL was running in 2 minutes. Writing the first Drizzle schema and running queries was intuitive and fast.

- **Whether we would build with it again and why**:
  - **Yes, unconditionally.** PostgreSQL 16 remains the gold standard for relational financial systems, and Drizzle provides the cleanest, most performant TypeScript ORM available.

---

## 7. Next.js 15 App Router & React 19

- **What we used it for**:  
  The operator web console, live Books Dashboard, and voice simulator at `/voice` featuring push-to-talk audio streaming, real-time waveform visualizer, and MCP App card renderers.

- **What worked well**:
  - App Router route handlers (`/api/voice`, `/api/health`) provided clean streaming response bridges between Bedrock and the client.
  - Fast page compilation with Turbopack during development.
  - Clean server-side rendering for financial overview metrics and ledger summaries.

- **What needs improvement**:
  - Client/server boundary errors can be cryptic when passing non-serializable objects (e.g. BigInt) across Server Actions or Client Components without explicit serialisers.
  - Web Speech API integration required strict client-only hydration guards (`'use client'` + `useEffect`) to avoid SSR hydration mismatches.

- **Onboarding experience from zero to hello world**:
  - Immediate setup via standard template; building complex real-time audio visualization components required custom Canvas hooks.

- **Whether we would build with it again and why**:
  - **Yes.** Next.js 15 is our default full-stack React framework for building modern web consoles.

---

## 8. Web Speech API (Browser Native SpeechRecognition & SpeechSynthesis)

- **What we used it for**:  
  Zero-dependency client-side speech-to-text (STT) and text-to-speech (TTS) in the Alexa+ web simulator, supporting natural voice input for invoice generation, expense logging, and month-end briefings.

- **What worked well**:
  - Zero cloud latency and zero cost for transcription and speech synthesis: runs entirely within modern browsers.
  - Native Indian English accents (`en-IN`) are supported across Chrome and Edge.

- **What needs improvement**:
  - Firefox does not natively support `webkitSpeechRecognition` without manual flag toggles.
  - Background audio auto-stop behaviors vary across browsers during pauses in speech.

- **Onboarding experience from zero to hello world**:
  - Hello world speech capture took 15 minutes, but hardening continuous speech and fallback synthetic audio required defensive state management.

- **Whether we would build with it again and why**:
  - **Yes, for simulators.** For hardware-free hackathon judging and browser simulators, Web Speech API provides an instant voice experience without requiring physical smart speakers.

---

## 9. Terraform AWS Provider (`hashicorp/aws`)

- **What we used it for**:  
  Automated Infrastructure-as-Code provisioning of the complete production environment: VPC, Dual-AZ Subnets, Internet & NAT Gateways, ECR Repositories, RDS PostgreSQL 16, Secrets Manager, App Runner Services, and IAM Roles.

- **What worked well**:
  - Declarative, reproducible infrastructure with staged deployment flags (`enable_apprunner_services`) to prevent bootstrap race conditions.
  - `random_password` provider with URL-safe character overrides ensured database passwords interpolate safely into `DATABASE_URL`.

- **What needs improvement**:
  - App Runner resources take several minutes to create and destroy in Terraform plans.
  - Secrets Manager integration in App Runner requires explicit secret ARN mapping for environment variables.

- **Onboarding experience from zero to hello world**:
  - Terraform plan to clean AWS deployment took ~15 minutes of authoring.

- **Whether we would build with it again and why**:
  - **Yes.** Essential for immutable, repeatable production cloud deployments.

---

## 10. AWS Secrets Manager SDK (`@aws-sdk/client-secrets-manager`)

- **What we used it for**:  
  Dynamic retrieval and parsing of administrative database credentials (`kanakku/production/database-admin-credentials`) and runtime connection strings (`kanakku/production/database-url`) during least-privilege PostgreSQL user provisioning in `bootstrapAppRole`.

- **What worked well**:
  - Clean `GetSecretValueCommand` API in AWS SDK v3 with seamless IAM task role authentication.
  - Native JSON payload storage allowed bundling host, port, username, and password into a single rotatable secret.

- **What needs improvement**:
  - SDK responses return `SecretString` as a raw string, requiring manual `JSON.parse()` error handling.
  - Local offline development requires fallback environment variable injection when AWS credentials are not configured.

- **Onboarding experience from zero to hello world**:
  - Under 10 minutes: instantiating `SecretsManagerClient` and fetching secret values required only 8 lines of TypeScript.

- **Whether we would build with it again and why**:
  - **Yes.** Centralized, encrypted secrets storage with IAM role-based access is non-negotiable for enterprise database security.

---

## 11. Zod Runtime Schema Validation (`zod`)

- **What we used it for**:  
  Strict runtime schema validation for financial tool parameters, confirmation token payloads, invoice/expense inputs, and type-safe parameter definitions across all 13 canonical MCP tools.

- **What worked well**:
  - First-class TypeScript type inference (`z.infer<typeof schema>`) guaranteed complete synchronization between runtime validation and static compile checks.
  - Direct integration with `@modelcontextprotocol/sdk` tool definitions, enabling declarative JSON Schema generation for LLM tool invocation.
  - `safeParse` provided deterministic, non-throwing validation pipelines for voice intent inputs.

- **What needs improvement**:
  - Handling integer paise BigInt values required custom string transformations (`z.string().regex(/^\d+$/).transform(BigInt)`) rather than a native `z.bigint()` coercion in older tool inputs.
  - Error messages for deeply nested line-item arrays can produce verbose issue arrays that require custom formatting before returning to conversational voice agents.

- **Onboarding experience from zero to hello world**:
  - Under 5 minutes: declaring basic object schemas and parsing JSON objects was immediately intuitive.

- **Whether we would build with it again and why**:
  - **Yes, unconditionally.** Zod is the essential gatekeeper preventing invalid, malformed, or hostile LLM tool arguments from reaching core accounting ledger logic.
