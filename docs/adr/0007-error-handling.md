# Error handling

Status: accepted

> Error pattern inspired by [cowprotocol/services](https://github.com/cowprotocol/services): typed error kinds in domain/infra code, opaque errors only at the startup shell.

## Context

The service needs a consistent error strategy that satisfies two audiences: sub-solvers who need machine-readable rejection reasons, and operators who need structured logs with enough context to debug.

## Decision

- **Typed error kinds in `domain/` and `infra/`.** Errors that cross a module boundary carry a typed `kind`; validation failures name the rule they broke. The proposal-ingestion pipeline in particular needs typed rejections, because [ADR-0001](0001-proposal-api.md) promises sub-solvers a machine-readable 4xx reason for every rejection.
- **Opaque errors only at the outermost shell** — startup (`index.ts`), where the only consumer is a log line and a non-zero exit — and in test/setup code, where ergonomics beat taxonomy.
- **HTTP errors follow the CoW driver shape**: a `Kind` enum (PascalCase on the wire) plus `{ kind, description }` body, mapped through Hono's `app.onError`. The proposal API's rejection reasons (bad signature, under-collateralized, simulation revert, rate-limited, fee not covered, …) are one such enum; the `/solve` API reuses the error kinds the driver already expects from solver engines.
- **No unhandled exceptions on request paths.** Uncaught errors are reserved for startup invariant violations (bad config caught before serving). Hono's `app.onError` catches everything on request paths and returns structured JSON.
- **Errors are for callers, logs are for operators**: attach operator context (order UID, signer, proposal id) at the log site via tracing fields, not by stuffing it into error strings.

## Alternatives considered

- **Untyped errors everywhere.** Fastest to write. Rejected — the ingestion API contractually needs distinguishable rejection reasons, and string-matching error messages is fragile.
- **Typed errors everywhere including startup.** Rejected — a `StartupError` enum nobody matches on is ceremony; the startup shell can use opaque errors.
- **A single repo-wide error enum.** Rejected — it grows unboundedly and couples unrelated modules; per-boundary enums keep each API's failure surface explicit.

## Consequences

- Typed rejection enums double as the proposal API's documented error catalogue — the OpenAPI spec and the code share one source of truth.
- More upfront typing than anyhow-style development; the payoff is that sub-solver-facing behavior (which 4xx, which reason) is compiler-checked rather than string-matched.
