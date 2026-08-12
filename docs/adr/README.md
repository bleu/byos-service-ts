# Architecture Decision Records

This directory holds the ADRs for the TypeScript BYOS service. Domain-level ADRs (0001-0003, 0005, 0007, 0010-0013) are carried over from the [Rust BYOS service](https://github.com/bleu/byos-service/tree/main/docs/adr). Implementation-specific ADRs (workspace, config, observability, testing) will be written fresh for the TypeScript stack.

## Index

Domain ADRs (to be copied from Rust repo):
- 0001 — Proposal API
- 0002 — Solver Engine
- 0003 — Slash Attribution Flow
- 0005 — Crate Anatomy and Layering
- 0007 — Error Handling
- 0010 — Settlement Outcome Source
- 0011 — Owner-Scoped Reads
- 0012 — Simulation
- 0013 — Proposal Lifecycle and Retention

TypeScript-specific ADRs (to be written):
- 0004 — pnpm Monorepo and Tooling (replaces Cargo Workspace)
- 0006 — Configuration (env vars + Zod)
- 0008 — Observability (pino)
- 0009 — Testing Strategy (Vitest)
