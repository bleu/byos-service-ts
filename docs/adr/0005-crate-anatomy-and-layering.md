# Package anatomy & internal layering

Status: accepted

> Layering pattern inspired by [cowprotocol/services](https://github.com/cowprotocol/services), where `crates/driver` and `crates/solvers` are the canonical examples of domain/infra separation.

Spec: [docs/shared/service.md](../shared/service.md)

## Context

We need a standard shape for packages in this workspace: how apps are structured, where business logic lives versus IO code, and where wire types go.

## Decision

### Package set

| Package | Kind | Role |
|---|---|---|
| `apps/byos` | app | The BYOS service: public proposal API + solver engine, one process, two listeners ([ADR-0001](0001-proposal-api.md)) |
| `apps/subsolver` | app | Reference sub-solver: example proposal-API client, e2e-test counterpart, documentation for external teams |
| `packages/common` | library | Shared types: EIP-712 encoding, ABIs, DTOs, settlement encoding |
| `tests/e2e` | tests | End-to-end tests: in-process Hono apps with real Postgres ([ADR-0009](0009-testing-strategy.md)) |

New capabilities get their own small, single-purpose, kebab-case-named packages rather than growing a `utils` module.

### domain / infra split

Inside `apps/byos` (and `apps/subsolver` once it grows):

- `domain/` — pure business logic, no IO: proposal store and lifecycle, scoring and selection, eligibility math, attribution. Types here are the CONTEXT.md vocabulary.
- `infra/` — everything touching the outside world: `api/` (Hono routes with Zod request schemas), `blockchain/` (RPC via viem, simulation, escrow operator), `config/`, `jobs/` (BullMQ workers), `persistence/` (Drizzle queries, audit trail).
- DTOs live next to the route or adapter that uses them; conversion to domain types happens at the edge. Wire types shared across packages are in `packages/common`, so the `byos` server and any sub-solver client serialize one model.

### Solver-engine shape

The engine is a plain function (`solve(auction, proposals) → solutions`), not a class hierarchy. BYOS has exactly one engine (the proposal-cache engine); abstraction can be introduced if a second engine ever exists.

### Wire conventions (packages/common and the /solve API)

Match the Solver Engine API conventions from the CoW driver: camelCase JSON, 256-bit amounts as decimal strings, addresses and order UIDs as hex strings, RFC3339 deadlines. The `/solve` side of `apps/byos` implements that existing spec as-is (BYOS must look like a vanilla solver engine to the driver); the proposal API defines its own spec in the same idiom, kept as `apps/byos/openapi.yml`.

## Alternatives considered

- **One monolithic package.** Simpler initially. Rejected — the sub-solver must be independently buildable and vendorable by external teams, and shared wire types must not drag in the whole service.
- **Solver class with inheritance.** More extensible in the abstract. Rejected — there is exactly one engine, and a plain function keeps `solve` simple and testable.
- **Hexagonal/ports-and-adapters naming (`ports/`, `adapters/`).** Same idea, different names. Rejected — `domain`/`infra` matches the existing CoW conventions.
- **Shared DTOs inside `apps/byos`, re-exported.** Rejected — clients would depend on the full service package; `packages/common` keeps the dependency arrow pointing the right way.

## Consequences

- The e2e tests can drive the real service and the real sub-solver in-process, no docker needed for the common path.
- Per-route Zod schemas mean some type duplication between wire format and domain types; that duplication is the point — wire format and domain model evolve independently.
- The `openapi.yml` for the proposal API becomes a deliverable in its own right and can be linted in CI.
