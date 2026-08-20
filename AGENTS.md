# Agent Guidelines

Instructions for AI agents working on this codebase.

## Project overview

This repo is the **BYOS service** — a CoW Protocol solver that sources routes from permissionless external sub-solvers. BYOS (Bring Your Own Solver) accepts settlement proposals, validates them against escrow collateral, and answers the CoW driver's `/solve` auction with the best route per order.

## Shared specification

The normative BYOS specification lives in `docs/shared/` (a Git submodule pointing to [bleu/byos-docs](https://github.com/bleu/byos-docs)). Domain vocabulary is in `docs/shared/glossary.md`. The design document is `docs/shared/design-document.md`. The API wire contract is at `apps/byos/openapi.yml`.

**Rule**: ADRs in this repo record *why* a decision was made. They do not restate *what is true* — the specification does that. Each domain ADR carries a `Spec:` line citing the relevant section. If an ADR and the specification disagree, the specification is correct.

## Repo structure

```
CONTEXT.md              Domain language and architecture map — read first
apps/byos/              The BYOS service (proposal API, solver engine, workers)
apps/subsolver/         Reference sub-solver client
packages/common/        Shared contract ABIs, EIP-712, DTOs, trampoline encoding
tests/e2e/              End-to-end tests
docs/adr/               Architecture decision records
docs/shared/            Shared BYOS specification (submodule → bleu/byos-docs)
apps/byos/openapi.yml   Proposal API spec
docker-compose.yml      Dev Postgres + Redis
```

## Before working

- Read [`CONTEXT.md`](CONTEXT.md), then the ADRs in [`docs/adr/`](docs/adr/) that touch the area you're about to work in. ADRs 0001–0003 are the domain decisions; the remainder cover engineering conventions.
- Read the shared specification in [`docs/shared/`](docs/shared/) for normative behavior — `design-document.md` is the source of truth.
- If your output contradicts an existing ADR, surface it explicitly rather than silently overriding: _"Contradicts ADR-0001 (GET returns metadata only) — but worth reopening because…"_
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
- **Prefer `@cowprotocol/cow-sdk` types** when they are identical to what we need (e.g., `OrderKind`, `SupportedChainId`, `BUY_ETH_ADDRESS`). Keep manual types when cow-sdk's version doesn't match our context (e.g., `SigningScheme` — cow-sdk uses numeric values, we need the orderbook wire format strings).

### Error handling

- Single `AppError` class with a `kind` field (string enum). Hono's `app.onError` maps `kind` → HTTP status + JSON body.
- Store errors carry a `retryable` flag (`should_retry()` classification).
- No `try/catch` in domain logic — domain functions return values or throw `AppError`.

### Background jobs (BullMQ)

- Background work uses **BullMQ repeatable jobs** backed by Redis — not `setTimeout` or `setInterval`.
- One `Queue` + `Worker` per job type: validation (every 12s), retention sweep (every 5m), penalty loop.
- The **audit trail** is a dedicated BullMQ queue for durable write-behind persistence. Events survive process crashes.
- **Rate limiting** uses Redis sliding windows (not in-memory).
- Jobs run with `concurrency: 1` by default — no overlapping ticks, missed ticks are delayed (not dropped).
- Shutdown order: close HTTP servers → `worker.close()` on all BullMQ workers (finishes current job) → drain audit queue → close Redis → close DB pool.

### Dependency injection

- Plain `AppContext` object built at startup, passed explicitly to Hono apps (via Hono `Env` type) and BullMQ worker processors. Contains DB pool, Redis connection, viem clients, BullMQ queues, and config.
- In tests, construct an `AppContext` with overrides (e.g., AcceptAll validator, test DB).

### Configuration

- All config via environment variables, validated with a Zod schema at startup.
- Fail-fast: missing or invalid config crashes with a clear message before the service starts.
- Secrets never appear in logs — don't log the raw config object.

### Testing

Five tiers, one command each. Everything but the unit tier needs `docker compose up -d postgres redis`.

| Tier | Lives in | Command | Needs |
|------|----------|---------|-------|
| Unit | beside the source, in `__tests__/` | `pnpm test` | nothing |
| DB | `apps/byos/src/**/*.db.test.ts` | `pnpm test:db` | Postgres |
| Redis | `apps/byos/src/**/*.redis.test.ts` | `pnpm test:redis` | Redis |
| Service-level / e2e | `tests/e2e/` | `pnpm test:e2e` | Postgres |
| On-chain | `tests/onchain/` | `pnpm test:onchain` | anvil on PATH, `RUN_ONCHAIN_TESTS=1` |

The Redis tier shares one Redis, so each test namespaces its keys and sweeps them afterwards. The e2e tier builds both Hono apps in-process — it does not need a running service. Every DB-backed test gets its own database; `apps/byos/test/setup.ts` creates it and sweeps stale ones. The on-chain tier self-skips without `RUN_ONCHAIN_TESTS=1`, which is why CI does not run it.

### Wire format

- **camelCase JSON** for all API request/response bodies.
- **256-bit amounts as decimal strings** (`"1000000000000000000"`, not hex, not number).
- **Addresses and order UIDs as `0x`-prefixed hex strings**.
- This matches the API contract defined in `apps/byos/openapi.yml` — do not change it.

## Domain language

The glossary lives in [`CONTEXT.md`](CONTEXT.md) — sub-solver, proposal, ingestion, proposal store, audit trail, gatekeeping, attribution, Track A/B, `c_l`, operator. Use those terms exactly in code, test names, and documentation. Key distinctions:

- `sub_solver` / `subSolver` — the external party. Never plain `solver` (that means BYOS itself in CoW's vocabulary).
- `gas cut` — not "fee". The order's signed `feeAmount` is a different field.
- `ingestion` — the `POST /proposals` path. Does NOT include simulation or escrow checks.

## Related repositories

- [`bleu/byos-docs`](https://github.com/bleu/byos-docs) — Shared BYOS specification (submodule at `docs/shared/`).
- [`bleu/byos-contracts`](https://github.com/bleu/byos-contracts) — Escrow, Trampoline, TrampolineFactory (Foundry). EIP-712 domain and `ProposalData` schema defined there.
- [`cowprotocol/services`](https://github.com/cowprotocol/services) — the CoW backend (driver/autopilot) BYOS integrates with.
- [`cowdao-grants/offline-mode`](https://github.com/cowdao-grants/offline-mode) — offline CoW-stack for full e2e testing.
