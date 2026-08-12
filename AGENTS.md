# Agent Guidelines

Instructions for AI agents working on this codebase.

## Project overview

This repo is the **TypeScript rewrite** of the Rust BYOS service ([`bleu/byos-service`](https://github.com/bleu/byos-service)). BYOS (Bring Your Own Solver) is a CoW Protocol solver that sources routes from permissionless external sub-solvers. It is a migration — the Rust codebase is the reference implementation. Domain logic, behavior, and API contracts must match. The full migration plan lives in [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Repo structure

```
CONTEXT.md              Domain language and architecture map — read first
docs/IMPLEMENTATION_PLAN.md  Migration plan, file mappings, phase order
apps/byos/              The BYOS service (proposal API, solver engine, workers)
apps/subsolver/         Reference sub-solver client
packages/common/        Shared contract ABIs, EIP-712, DTOs, trampoline encoding
tests/e2e/              End-to-end tests
docs/adr/               Architecture decision records
docs/reference/         CoW protocol background (slashing, auctions, CIPs)
apps/byos/openapi.yml   Proposal API spec
docker-compose.yml      Dev Postgres + Redis
```

## Before working

- Read [`CONTEXT.md`](CONTEXT.md), then the ADRs in [`docs/adr/`](docs/adr/) that touch the area you're about to work in. ADRs 0001–0003 are the domain decisions; the remainder cover engineering conventions.
- Read [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) to understand the migration phases, file mappings, and cross-cutting patterns.
- If your output contradicts an existing ADR, surface it explicitly rather than silently overriding: _"Contradicts ADR-0001 (GET returns metadata only) — but worth reopening because…"_
- The **Rust source** at `../byos-service` is the reference implementation. When porting a module, read the corresponding Rust file first (see the file mapping table in the implementation plan). Preserve behavior and edge cases — don't simplify unless the plan explicitly says to.
- Contract interfaces (Escrow, Trampoline, EIP-712 `ProposalData`) are owned by [`bleu/byos-contracts`](https://github.com/bleu/byos-contracts) — check there before assuming a signature or event shape.

## Technology stack

| Concern | Tool |
|---------|------|
| Runtime | Node |
| Web framework | Hono (two apps: public on 9585, internal on 9586) |
| Database | Drizzle ORM + Postgres |
| Background jobs | BullMQ (repeatable jobs, audit queue) |
| Job store / cache | Redis |
| Blockchain | viem |
| CoW Protocol types | `@cowprotocol/cow-sdk` (OrderKind, SupportedChainId, BUY_ETH_ADDRESS) |
| Validation | Zod |
| Logging | pino |
| Build | tsup |
| Tests | Vitest |
| Lint + format | Biome |
| Package manager | pnpm (workspaces) |
| Config | Environment variables validated with Zod |

## Key conventions

### Code organization

- **`domain/`** is pure — no IO, no imports from `infra/`, no database, no RPC. Only depends on `packages/common`.
- **`infra/`** owns Hono routes, viem clients, Drizzle queries, pino logging, config, persistence.
- **DTO conversion happens at the edges** — Zod schemas parse wire format into domain types at API entry, domain types convert to response JSON at API exit.
- The **`/solve` hot path** never does RPC, simulation, or DB writes beyond the solutions insert — expensive validation belongs in ingestion or the background loops.

### File naming

- **kebab-case** for all files: `gas-cut.ts`, `proposal-store.ts`, `trampoline-factory.ts`.
- One ABI per file in `packages/common/src/abis/`, named export with `as const`.

### TypeScript

- Strict mode everywhere (`tsconfig.base.json` with `strict: true`).
- Native `bigint` for 256-bit values internally. Decimal strings on the wire (JSON) and in the database (TEXT columns). Zod transforms at boundaries.
- No `any` — use `unknown` and narrow.
- No classes except `AppError`. Prefer plain objects and functions.
- **Prefer `@cowprotocol/cow-sdk` types** when they are identical to what we need (e.g., `OrderKind`, `SupportedChainId`, `BUY_ETH_ADDRESS`). Keep manual types when cow-sdk's version doesn't match our context (e.g., `SigningScheme` — cow-sdk uses numeric values, we need the orderbook wire format strings). See the cow-sdk mapping table in the implementation plan for the full list.

### Error handling

- Single `AppError` class with a `kind` field (string enum). Hono's `app.onError` maps `kind` → HTTP status + JSON body.
- Store errors carry a `retryable` flag (mirrors Rust's `StoreError::should_retry()`).
- No `try/catch` in domain logic — domain functions return values or throw `AppError`.

### Background jobs (BullMQ)

- Background work uses **BullMQ repeatable jobs** backed by Redis — not `setTimeout` or `setInterval`.
- One `Queue` + `Worker` per job type: validation (every 12s), retention sweep (every 5m), penalty loop.
- The **audit trail** is a dedicated BullMQ queue for durable write-behind persistence. Events survive process crashes.
- **Rate limiting** uses Redis sliding windows (not in-memory).
- Jobs run with `concurrency: 1` by default — no overlapping ticks, same semantics as the Rust service's `MissedTickBehavior::Delay`.
- Shutdown order: close HTTP servers → `worker.close()` on all BullMQ workers (finishes current job) → drain audit queue → close Redis → close DB pool.

### Dependency injection

- Plain `AppContext` object built at startup, passed explicitly to Hono apps (via Hono `Env` type) and BullMQ worker processors. Contains DB pool, Redis connection, viem clients, BullMQ queues, and config.
- In tests, construct an `AppContext` with overrides — same pattern as the Rust test harness.

### Configuration

- All config via environment variables, validated with a Zod schema at startup.
- Fail-fast: missing or invalid config crashes with a clear message before the service starts.
- Secrets never appear in logs — don't log the raw config object.

### Testing

- **Unit tests**: colocated with source or in `__tests__/` directories. Test domain logic in isolation.
- **Service-level tests**: in `apps/byos/test/`. Require Postgres (docker-compose). Each test gets a unique database — see `test/setup.ts`.
- **E2e tests**: in `tests/e2e/`. Require anvil + both services running.
- Run unit tests: `pnpm test`
- Run DB tests: `pnpm test:db`

### Wire format

- **camelCase JSON** for all API request/response bodies.
- **256-bit amounts as decimal strings** (`"1000000000000000000"`, not hex, not number).
- **Addresses and order UIDs as `0x`-prefixed hex strings**.
- This matches the existing Rust API contract — do not change it.

## Domain language

The glossary lives in [`CONTEXT.md`](CONTEXT.md) — sub-solver, proposal, ingestion, proposal store, audit trail, gatekeeping, attribution, Track A/B, `c_l`, operator. Use those terms exactly in code, test names, and documentation. Key distinctions:

- `sub_solver` / `subSolver` — the external party. Never plain `solver` (that means BYOS itself in CoW's vocabulary).
- `gas cut` — not "fee". The order's signed `feeAmount` is a different field.
- `ingestion` — the `POST /proposals` path. Does NOT include simulation or escrow checks.

## How to port a Rust module

1. **Read the Rust source** — understand the full behavior, including edge cases and error paths.
2. **Read the corresponding ADRs** — understand why it was built that way.
3. **Read the Rust tests** — these define the expected behavior. Port them first (TDD).
4. **Write the TypeScript equivalent** — match behavior, not syntax. Use idiomatic TypeScript (no Rust patterns like `Result<T, E>` wrappers).
5. **Verify** — all ported tests pass, `pnpm typecheck` clean, `pnpm lint` clean.

When in doubt about behavior, the Rust code is authoritative. When in doubt about TypeScript patterns, follow the conventions in this file and the implementation plan.

## Related repositories

- [`bleu/byos-service`](https://github.com/bleu/byos-service) — the Rust reference implementation (at `../byos-service` locally).
- [`bleu/byos-contracts`](https://github.com/bleu/byos-contracts) — Escrow, Trampoline, TrampolineFactory (Foundry). EIP-712 domain and `ProposalData` schema defined there.
- [`cowprotocol/services`](https://github.com/cowprotocol/services) — the CoW backend (driver/autopilot) BYOS integrates with.
- [`cowdao-grants/offline-mode`](https://github.com/cowdao-grants/offline-mode) — offline CoW-stack for full e2e testing.
