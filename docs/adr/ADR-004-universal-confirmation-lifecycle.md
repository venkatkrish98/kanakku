# ADR-004: Universal Confirmation Lifecycle, Hashed Token Storage, and Idempotency

## Status

Accepted

## Context

In financial voice agents, state-changing actions (expenses, invoices, payment reminders, period close) must never execute spontaneously without explicit human consent. Storing plaintext confirmation tokens in the database exposes a security vulnerability where database readers or log dumps could yield valid action tokens. Furthermore, network retries by voice clients or web frontends require a deterministic idempotency strategy to prevent duplicate transactions.

## Decision

### 1. Hashed Token Storage (`token_hash`)

- **Generation**: When a draft action is created, the server generates a cryptographically secure 32-character random hex token (`token_secret = crypto.randomBytes(16).toString('hex')`).
- **Database Storage**: The raw `token_secret` is **never** persisted in the database. Instead, the server computes `token_hash = SHA-256(token_secret)` and stores `token_hash` in `pending_confirmations`.
- **Client Presentation**: The raw `token_secret` is returned to the client as `confirmation_token` alongside the draft preview.
- **Verification**: When the client calls `confirm_action(confirmation_token)`, the server computes `SHA-256(confirmation_token)` and looks up `WHERE token_hash = computed_hash`.

### 2. Dual Idempotency Strategy (Atomic Single-Use + Optional Keyed Replay)

To handle network retries safely:

- **Baseline (Token Single-Use Guard)**:
  Every confirmation lookup verifies `consumed_at IS NULL` within a `SELECT FOR UPDATE` transaction. Upon execution, `consumed_at = now()`. Any second submission with the same token is rejected with `TOKEN_ALREADY_CONSUMED`.
- **Client-Keyed Idempotency (`idempotency_records` table)**:
  When an optional `idempotency_key` is supplied to `confirm_action`:
  1. The server checks the `idempotency_records` table for `(business_id, idempotency_key)`.
  2. If found with `status = 'completed'`, the server returns the cached `response_payload` immediately without re-executing.
  3. If found with `status = 'pending'` and unexpired lock, the server rejects the concurrent request with `409 Conflict (IN_FLIGHT)`.
  4. If not found, the server inserts a row in `idempotency_records` with `status = 'pending'`, executes the draft consumption and ledger write within an atomic transaction, updates `idempotency_records` to `status = 'completed'` with the serialized `response_payload`, and commits.

### 3. Schema Contract Alignment

Table `pending_confirmations`:

- `id`: UUID (PK)
- `business_id`: UUID (FK)
- `user_id`: UUID (FK)
- `token_hash`: text NOT NULL UNIQUE (SHA-256 of the issued token)
- `action_type`: text NOT NULL (`record_expense`, `create_invoice`, `send_payment_reminder`, `close_month`)
- `payload`: jsonb NOT NULL (canonical action arguments)
- `payload_hash`: text NOT NULL (SHA-256 of canonical payload string)
- `human_summary`: text NOT NULL
- `expires_at`: timestamptz NOT NULL (now() + 15 min)
- `consumed_at`: timestamptz NULL
- `created_at`: timestamptz default now()

Table `idempotency_records`:

- `id`: UUID (PK)
- `business_id`: UUID (FK)
- `idempotency_key`: text NOT NULL
- `action_type`: text NOT NULL
- `status`: text NOT NULL (`pending`, `completed`, `failed`)
- `response_payload`: jsonb NULL
- `locked_until`: timestamptz NOT NULL
- `created_at`: timestamptz default now()
- Unique constraint: `UNIQUE(business_id, idempotency_key)`

## Consequences

- **Positive**: Complete defense-in-depth: database compromise or log leaks cannot expose valid action tokens.
- **Positive**: Mathematically sound idempotency: callers providing `idempotency_key` safely receive exact cached responses on retries.
- **Positive**: Strict single-use protection even if no `idempotency_key` is supplied.
