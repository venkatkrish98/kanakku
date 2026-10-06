# ADR-003: Financial Writes via Two-Phase Draft-Review-Confirm-Execute Flow

## Status

Accepted

## Context

Voice interfaces have intrinsic speech recognition ambiguity (e.g. misinterpreting names, amounts, or payment modes). In financial software, an irreversible ledger write or external payment reminder sent accidentally to a client can cause legal, financial, and reputational damage.

## Decision

Every state-changing operation in Kanakku must adhere strictly to a two-phase transaction lifecycle:
`DRAFT` → `REVIEW` → `CONFIRM` → `EXECUTE`

1. First turn: User issues an intent (e.g., "Log 2,400 for printer ink"). The system creates an uncommitted draft and yields a cryptographically secure, time-limited (15-minute TTL) `confirmation_token` alongside a structured preview card.
2. Second turn: Only upon explicit confirmation by the user (clicking [Confirm] or saying "Confirm it") referencing the token does the system execute the write in an atomic database transaction, marking the token consumed and logging an audit event.

## Consequences

- **Positive**: Complete prevention of accidental or hallucinated ledger writes.
- **Positive**: Full idempotency protection preventing double-posting from network retries.
- **Positive**: Strict audit compliance with before/after state diffs linked to confirmation tokens.
- **Neutral**: Requires cross-turn session state management to persist draft tokens and handle TTL expirations cleanly.
