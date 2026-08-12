# ADR-0006: Configuration

**Status:** Accepted

## Context

For a containerized service, environment variables are the standard configuration mechanism — CLI flags add unnecessary complexity.

## Decision

**Environment variables only**, validated with a Zod schema at startup.

### Fail-fast

Missing or invalid config crashes the process with a clear error message before any listeners bind or DB connections open. No partial startup.

### Validation

A single Zod schema (`configSchema` in `src/config.ts`) defines all variables with types, defaults, and constraints. `z.coerce.number()` handles string-to-number conversion for port numbers and intervals.

### Secrets

Secrets (`DATABASE_URL`, `RPC_URL`, `OPERATOR_PRIVATE_KEY`, `SOLVE_BEARER_TOKEN`) are never logged. The parsed config object should not be passed to loggers.

### Development

`dotenv` loads `.env` files in development. The `.env.example` file documents all variables with defaults.

### Conditional groups

When `RPC_URL` is set, several related variables become required (`ESCROW_ADDRESS`, `SETTLEMENT_ADDRESS`, `ORDERBOOK_URL`, `MIN_COLLATERAL`, `DEFAULT_GAS_PRICE`). Without `RPC_URL`, the service runs with `AcceptAll` validation (useful for development).

Similarly, `OPERATOR_PRIVATE_KEY` is optional — without it, the penalty loop is disabled.
