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

### Required fields

`RPC_URL`, `ESCROW_ADDRESS`, `DEFAULT_GAS_PRICE`, and `OPERATOR_PRIVATE_KEY` are all required. BYOS cannot validate proposals without an RPC connection, and the penalty loop requires an operator key. Omitting any of these fails startup with a clear error.

`ORDERBOOK_URL` and `SETTLEMENT_ADDRESS` resolve automatically from `CHAIN_ID` via the cow-sdk and only need to be set for barn/staging overrides.

### Protocol deployment metadata

`FLASH_LOAN_ROUTER` is an optional override for local/custom deployments. Without it,
startup resolves `FlashLoanRouter[CHAIN_ID].address` from CoW's deployment registry.
An unavailable or invalid registry entry falls back to the canonical router address;
this avoids making registry availability a service startup requirement. Runtime
configuration remains environment-based; the registry supplies protocol metadata.
