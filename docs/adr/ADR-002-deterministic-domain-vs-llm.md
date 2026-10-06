# ADR-002: Separation of Deterministic Financial Domain Logic from Bedrock Reasoning

## Status

Accepted

## Context

Generative AI models and LLMs (such as Claude 3.5 on Amazon Bedrock) are probabilistic token predictors. When tasked with arithmetic, tax percentage computations, or currency rounding, LLMs can hallucinate or produce precision errors. In accounting and Indian GST compliance, any discrepancy in paise or tax splitting is unacceptable.

## Decision

All financial calculations, tax liability computations, invoice number sequence generation, and ageing calculations must be executed exclusively by pure, deterministic TypeScript domain modules in `packages/core`. Amazon Bedrock is strictly confined to:

1. Intent recognition and unstructured voice text parsing.
2. Expense categorization suggestions with numerical confidence scores.
3. Natural language narrative generation and human-readable summarization.

## Consequences

- **Positive**: 100% mathematical precision and reproducibility across all accounting reports and GST returns.
- **Positive**: Core logic is 100% testable via unit tests without mocking or calling LLMs.
- **Positive**: Strict regulatory compliance with Indian GST rules (CGST/SGST/IGST splits).
- **Negative**: Requires strict Zod schema validation between the agent reasoning layer and the domain execution layer.
