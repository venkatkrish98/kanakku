# ADR-001: Self-Hosted MCP Server with Streamable HTTP Transport

## Status

Accepted

## Context

The Amazon Developer Hackathon 2026 Alexa+ track requires a self-hosted Model Context Protocol (MCP) server adhering to specification version `2025-11-25` or higher. Legacy MCP transports utilized stdio or server-sent events (SSE) without standardized bidirectionality.

## Decision

We implement a self-hosted TypeScript MCP server using the official `@modelcontextprotocol/sdk` exposed via a single Streamable HTTP endpoint at `/mcp`.

## Consequences

- **Positive**: Clean HTTP-based streaming communication natively compatible with standard cloud load balancers, AWS App Runner, ECS, and modern web clients.
- **Positive**: Direct compatibility with the official MCP Inspector for live judge evaluations.
- **Neutral**: Requires stateless or sticky session handling for client session IDs over HTTP POST/GET stream pipelines.
