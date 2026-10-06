# ADR-005: Double-Entry Ledger and Serialized Hash-Chained Audit Trail

## Status

Accepted

## Context

A financial tool that only stores high-level invoices and expense records lacks full accounting integrity. Operations such as `explain_transaction` require granular visibility into how a business event affects balances (debits and credits). Furthermore, compliance standards require tamper-detection mechanisms rather than simple append-only application logs.

## Decision

1. **Double-Entry Journal**: Every executed financial transaction (invoice issued, expense posted, payment received, credit note issued) writes a corresponding `journal_entries` header and balanced `journal_lines` records (sum of debits == sum of credits).
2. **Serialized Hash-Chained Audit Log**:
   - Write operations to `audit_logs` are strictly serialized per tenant using a PostgreSQL advisory transaction lock (`pg_advisory_xact_lock`).
   - Each entry stores a strictly monotonic `sequence_number`, `prev_hash` (pointing to the entry hash of `sequence_number - 1`), and `entry_hash = SHA256(prev_hash + sequence_number + timestamp + action + entity_id + payload_hash)`.
   - Any manual row modification or out-of-order deletion breaks the cryptographic chain upon verification via `verifyAuditChain(businessId)`.

### Threat Model & Boundary

- **Guarantees**: Detects application bugs, SQL injection mutations, rogue queries, or data corruption that alter rows without recalculating the sequential chain.
- **Boundaries**: Does not prevent a database superuser with raw administrative access from modifying rows and recomputing all downstream hashes. To guard against superuser alterations in production (Phase 7), the latest head hash will be periodically anchored to an immutable external sink (Amazon CloudWatch Logs or S3 Object Lock).

## Consequences

- **Positive**: Provides authentic, production-grade bookkeeping capabilities and transparent explanations of transactions.
- **Positive**: Cryptographically verifiable audit integrity without race conditions or branching.
- **Neutral**: Requires tenant-scoped serialization during financial commit operations, well within SMB throughput requirements (< 100 writes/sec per tenant).
