# Architecture Decision Records

This directory holds the ADRs for the BYOS service. Domain ADRs (0001–0003, 0005, 0007, 0010–0015) cover service-wide design decisions. Implementation ADRs (0004, 0006, 0008, 0009) cover TypeScript-specific tooling and conventions. Each domain ADR cites the relevant section of the shared specification in `docs/shared/design-document.md`; if an ADR and the spec disagree, the spec wins.

## Index

### Domain ADRs

- [0001 — Proposal API](0001-proposal-api.md): Public HTTP API for sub-solver proposal ingestion, EIP-712 auth, two-listener architecture; revised 2026-08-14 (minBuyAmount/quoteBuyAmount split)
- [0002 — Solver Engine](0002-solver-engine.md): `/solve` hot path, `surplus - gas` scoring, gas cut, Trampoline settlement crafting; revised 2026-08-14 (minBuyAmount/quoteBuyAmount split)
- [0003 — Slash Attribution Flow](0003-slash-attribution-flow.md): Track A (gas + revert penalty) and Track B (EBBO/fairness) risk classes; revised 2026-08-14 (buffer debit for minBuyAmount/quoteBuyAmount)
- [0005 — Crate Anatomy and Layering](0005-crate-anatomy-and-layering.md): `domain/` (pure) vs `infra/` (IO) separation, DTO conversion at edges
- [0007 — Error Handling](0007-error-handling.md): Typed error kinds, machine-readable on the wire, `should_retry()` classification
- [0010 — Settlement Outcome Source](0010-settlement-outcome-source.md): Driver `/notify` as source of truth (no chain watcher)
- [0011 — Owner-Scoped Reads](0011-owner-scoped-reads.md): EIP-712 ReadAuth signatures, 404 for non-owners (no existence oracle)
- [0012 — Simulation](0012-simulation.md): Full `settle()` simulation via `eth_estimateGas` with state overrides
- [0013 — Proposal Lifecycle and Retention](0013-proposal-lifecycle-and-retention.md): 10-state lifecycle, retention sweep, executing timeout backstop
- [0014 — Contract Artifact Provenance](0014-contract-artifact-provenance.md): Vendored ABIs from byos-contracts submodule
- [0015 — Rate Limiting](0015-rate-limiting.md): Cloudflare edge per-IP filter, escrow-tiered per-signer sliding window, cached escrow floor gate
- [0016 — Active-Active Replicas and Durable Debits](0016-active-active-replicas-and-durable-debits.md): shared gas price and crash-safe escrow debit recovery

### TypeScript-specific ADRs

- [0004 — pnpm Monorepo and Tooling](0004-pnpm-monorepo-and-tooling.md): pnpm workspaces, tsup, Biome, Vitest, `tsc -b` project references
- [0006 — Configuration](0006-configuration.md): Env vars + Zod validation, fail-fast, dotenv for dev, conditional groups
- [0008 — Observability](0008-observability.md): pino structured logging, JSON/pretty output, BullMQ job metrics
- [0009 — Testing Strategy](0009-testing-strategy.md): Vitest workspace projects (unit/db/redis/integration/e2e), unique DB per test, Hono in-process testing
