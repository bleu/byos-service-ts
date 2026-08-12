# Implementation Plan — BYOS Rust → TypeScript Migration

This document describes the full migration plan for converting the Rust BYOS service (`../byos-service`) to TypeScript. It is the authoritative reference for the migration scope, technology choices, project structure, and implementation order.

## Decision Summary

| Concern | Choice |
|---------|--------|
| Web framework | Hono |
| Runtime | Node |
| Database | Drizzle ORM (Postgres) |
| Blockchain | viem |
| Package manager | pnpm |
| Build tool | tsup |
| Test runner | Vitest |
| Schema validation | Zod |
| Logging | pino |
| Linter / formatter | Biome |
| CI | GitHub Actions (lint.yml + test.yml) |
| Config | Environment variables validated with Zod + dotenv for dev |
| Error handling | Single `AppError` class with `kind` field |
| Background jobs | BullMQ repeatable jobs (Redis) |
| Job queue / cache store | Redis |
| Rate limiting | Redis-backed sliding window |
| Audit trail | BullMQ durable queue → Postgres |
| Graceful shutdown | `AbortController` (HTTP) + `worker.close()` (BullMQ) |
| DI / wiring | Plain `AppContext` object passed explicitly |
| BigInt strategy | Native `bigint` internally, string at boundaries (wire + DB) |
| Contract ABIs | One `.ts` file per contract, `as const` export |
| CoW protocol types | `@cowprotocol/cow-sdk` where identical + manual types for BYOS-specific structures |
| Gas price cache | Simple mutable property on `AppContext` |
| Validation concurrency | One BullMQ job per proposal, worker concurrency 8 (mirrors the Rust semaphore) |
| DB test isolation | Unique database per test |
| File naming | kebab-case |
| Task runner | pnpm scripts only |

## Project Structure

```
byos-service-ts/
├── apps/
│   ├── byos/                          # Main BYOS service
│   │   ├── src/
│   │   │   ├── domain/                # Pure business logic (no IO)
│   │   │   │   ├── proposal.ts        # Proposal types, lifecycle states
│   │   │   │   ├── scoring.ts         # score = surplus - gas
│   │   │   │   ├── validator.ts       # Validation seam interface
│   │   │   │   ├── penalty.ts         # Track A penalty policy
│   │   │   │   ├── audit.ts           # Audit event domain types
│   │   │   │   ├── order.ts           # Order validation envelope
│   │   │   │   └── gas-cut.ts         # Fee calculation
│   │   │   ├── infra/                 # IO and external services
│   │   │   │   ├── api/
│   │   │   │   │   ├── routes.ts      # Public CRUD endpoints
│   │   │   │   │   ├── solve.ts       # /solve hot path
│   │   │   │   │   ├── notify.ts      # /notify settlement outcomes
│   │   │   │   │   ├── error.ts       # HTTP error mapping
│   │   │   │   │   ├── dto.ts         # Wire type conversions
│   │   │   │   │   └── index.ts       # Two Hono apps (public + internal)
│   │   │   │   ├── blockchain/
│   │   │   │   │   ├── validator.ts   # Escrow + simulation validators
│   │   │   │   │   ├── escrow.ts      # Escrow balance checks
│   │   │   │   │   ├── simulation.ts  # Full settle() simulation
│   │   │   │   │   ├── operator.ts    # Escrow operator (debit signing)
│   │   │   │   │   └── index.ts
│   │   │   │   ├── storage.ts         # Drizzle proposal store
│   │   │   │   ├── audit.ts           # Audit trail (BullMQ queue → Postgres)
│   │   │   │   ├── rate-limit.ts      # Redis-backed rate limiter
│   │   │   │   ├── jobs/
│   │   │   │   │   ├── index.ts       # Queue/worker setup, Redis connection
│   │   │   │   │   ├── validation.ts  # Validation repeatable job
│   │   │   │   │   ├── penalty.ts     # Track A penalty repeatable job
│   │   │   │   │   └── retention.ts   # Retention sweep repeatable job
│   │   │   │   └── orderbook.ts       # CoW orderbook client
│   │   │   ├── config.ts             # Zod-validated env config
│   │   │   ├── context.ts            # AppContext type and builder
│   │   │   └── index.ts              # Entry point: startup, shutdown
│   │   ├── test/
│   │   │   ├── setup.ts              # Test DB harness, fixtures
│   │   │   └── cases/                # Service-level tests
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── subsolver/                     # Reference sub-solver
│       ├── src/
│       │   ├── domain/
│       │   │   ├── proposal.ts
│       │   │   └── routing.ts
│       │   ├── infra/
│       │   │   ├── blockchain.ts
│       │   │   ├── byos.ts           # BYOS API client
│       │   │   └── orderbook.ts
│       │   ├── config.ts
│       │   └── index.ts
│       ├── package.json
│       └── tsconfig.json
├── packages/
│   └── common/                        # Shared types, EIP-712, contracts
│       ├── src/
│       │   ├── abis/
│       │   │   ├── escrow.ts
│       │   │   ├── trampoline.ts
│       │   │   ├── trampoline-factory.ts
│       │   │   ├── gpv2-settlement.ts
│       │   │   └── erc20.ts
│       │   ├── eip712.ts             # EIP-712 domain, typed data, recovery
│       │   ├── contracts.ts          # Contract address types, helpers
│       │   ├── settlement.ts         # Settlement encoding
│       │   ├── trampoline.ts         # Calldata encoding for sub-solver routes
│       │   ├── dto.ts                # Wire types (proposal, auction, solution)
│       │   └── index.ts
│       ├── package.json
│       └── tsconfig.json
├── tests/
│   └── e2e/                           # Integration tests
│       ├── src/
│       │   └── ...
│       ├── package.json
│       └── tsconfig.json
├── docs/
│   ├── adr/                           # Architecture Decision Records
│   └── reference/                     # CoW Protocol background
├── docker-compose.yml                 # Dev Postgres + Redis
├── openapi.yml                        # Proposal API spec (copied from Rust)
├── biome.json
├── pnpm-workspace.yaml
├── package.json                       # Root: shared scripts, workspace config
├── tsconfig.base.json                 # Shared TS compiler options
├── CONTEXT.md                         # Domain language (copied from Rust, paths updated)
├── AGENTS.md                          # Agent guidelines for TS codebase
└── README.md
```

## Rust → TypeScript File Mapping

### packages/common (from `byos-common` + `proposal-dto`)

| Rust source | TypeScript target | Notes |
|-------------|-------------------|-------|
| `byos-common/src/contracts.rs` | `packages/common/src/abis/*.ts` + `contracts.ts` | `alloy::sol!` → `as const` ABI arrays |
| `byos-common/src/eip712.rs` | `packages/common/src/eip712.ts` | viem's `hashTypedData` / `recoverTypedDataAddress` |
| `byos-common/src/settlement.rs` | `packages/common/src/settlement.ts` | Settlement encoding helpers |
| `byos-common/src/trampoline.rs` | `packages/common/src/trampoline.ts` | Calldata encoding |
| `proposal-dto/src/proposal.rs` | `packages/common/src/dto.ts` | Wire types with Zod schemas |
| `proposal-dto/src/error.rs` | `packages/common/src/dto.ts` | Error types alongside DTOs |

### apps/byos (from `crates/byos`)

#### Domain layer

| Rust source | TypeScript target | Notes |
|-------------|-------------------|-------|
| `domain/proposal.rs` | `domain/proposal.ts` | Proposal types, state enum, lifecycle transitions |
| `domain/scoring.rs` | `domain/scoring.ts` | `score = surplus - gas` |
| `domain/gas_cut.rs` | `domain/gas-cut.ts` | Gas cost calculation |
| `domain/penalty.rs` | `domain/penalty.ts` | Track A penalty policy |
| `domain/audit.rs` | `domain/audit.ts` | Audit event types |
| `domain/order.rs` | `domain/order.ts` | Order validation envelope |
| `domain/validator.rs` | `domain/validator.ts` | Validation interface |

#### Infra layer

| Rust source | TypeScript target | Notes |
|-------------|-------------------|-------|
| `infra/api/routes.rs` | `infra/api/routes.ts` | Hono routes (proposals CRUD) |
| `infra/api/solve.rs` | `infra/api/solve.ts` | Hono route (/solve) |
| `infra/api/notify.rs` | `infra/api/notify.ts` | Hono route (/notify) |
| `infra/api/dto.rs` | `infra/api/dto.ts` | Request/response conversion |
| `infra/api/error.rs` | `infra/api/error.ts` | AppError → HTTP response |
| `infra/api/mod.rs` | `infra/api/index.ts` | Two Hono apps, middleware |
| `infra/storage.rs` | `infra/storage.ts` | Drizzle queries |
| `infra/audit.rs` | `infra/audit.ts` | Audit trail (BullMQ queue → Postgres) |
| `infra/validation.rs` | `infra/jobs/validation.ts` | Validation BullMQ repeatable job |
| `infra/penalty.rs` | `infra/jobs/penalty.ts` | Penalty BullMQ repeatable job |
| `infra/retention.rs` | `infra/jobs/retention.ts` | Retention sweep BullMQ repeatable job |
| `infra/orderbook.rs` | `infra/orderbook.ts` | CoW orderbook HTTP client |
| `infra/blockchain/validator.rs` | `infra/blockchain/validator.ts` | Escrow + simulation |
| `infra/blockchain/escrow.rs` | `infra/blockchain/escrow.ts` | viem contract reads |
| `infra/blockchain/simulation.rs` | `infra/blockchain/simulation.ts` | `eth_estimateGas` with state overrides |
| `infra/blockchain/operator.rs` | `infra/blockchain/operator.ts` | Debit signing via viem |

#### Database

| Rust source | TypeScript target | Notes |
|-------------|-------------------|-------|
| `migrations/0001–0006` | Drizzle schema + `drizzle-kit generate` | Define final schema in Drizzle, generate fresh migrations |

#### Tests

| Rust source | TypeScript target | Notes |
|-------------|-------------------|-------|
| `tests/setup/mod.rs` | `test/setup.ts` | Test DB creation, fixtures, helpers |
| `tests/cases/*.rs` | `test/cases/*.test.ts` | Vitest test files |

### apps/subsolver (from `crates/subsolver`)

| Rust source | TypeScript target | Notes |
|-------------|-------------------|-------|
| `domain/proposal.rs` | `domain/proposal.ts` | Proposal creation |
| `domain/routing.rs` | `domain/routing.ts` | Route computation |
| `infra/blockchain.rs` | `infra/blockchain.ts` | RPC access via viem |
| `infra/byos.rs` | `infra/byos.ts` | BYOS API HTTP client |
| `infra/orderbook.rs` | `infra/orderbook.ts` | Order discovery |
| `config.rs` | `config.ts` | Zod env config |
| `main.rs` + `run.rs` | `index.ts` | Entry point |

### tests/e2e (from `crates/e2e`)

| Rust source | TypeScript target | Notes |
|-------------|-------------------|-------|
| `e2e/src/chain.rs` | `src/chain.ts` | Anvil chain fixture |
| `e2e/src/lib.rs` | `src/*.test.ts` | E2e test cases |

## Implementation Phases

### Phase 0 — Project Scaffolding

Set up the monorepo skeleton with no business logic.

**Deliverables:**
- `pnpm-workspace.yaml` with `apps/*`, `packages/*`, `tests/*`
- Root `package.json` with shared scripts (`build`, `test`, `lint`, `typecheck`)
- `tsconfig.base.json` with strict mode, path aliases
- Per-package `package.json` and `tsconfig.json`
- `biome.json` at root
- `docker-compose.yml` for Postgres + Redis
- `.github/workflows/lint.yml` and `test.yml`
- `tsup.config.ts` per app
- `.env.example` with all required env vars
- `.gitignore`

**Rust reference:** `Cargo.toml` (workspace), `Justfile`, `.github/workflows/`

### Phase 1 — Shared Package (`packages/common`)

Port the foundational types and utilities shared by all apps.

**Deliverables:**
1. **Contract ABIs** — `src/abis/*.ts` with `as const` exports
2. **EIP-712** — `src/eip712.ts`: domain definition, `ProposalData`/`ReadAuth`/`CancelProposal` typed data, `recoverProposalSigner()`, `recoverReader()`, `recoverCanceller()` using viem
3. **Trampoline encoding** — `src/trampoline.ts`: calldata generation, CREATE2 address resolution
4. **Settlement encoding** — `src/settlement.ts`
5. **Wire types** — `src/dto.ts`: Zod schemas for `CreateProposalRequest`, `GetProposalResponse`, `ListProposalsResponse`, auction/solution types. `bigint` ↔ decimal string coercion at schema level.

**Rust reference:** `crates/byos-common/src/`, `crates/proposal-dto/src/`

**Tests:** Unit tests for EIP-712 recovery, trampoline encoding, DTO parsing. Use test vectors from the Rust test suite.

### Phase 2 — Domain Layer (`apps/byos/src/domain/`)

Port pure business logic. No IO, no dependencies beyond `packages/common`.

**Deliverables:**
1. **Proposal types** — `proposal.ts`: `ProposalStatus` enum (Submitted, Active, Rejected, Expired, Executing, Settled, SettleFailed, Penalized, SimFailed, Cancelled), `Proposal` type, state transition validation
2. **Scoring** — `scoring.ts`: `score = surplus - gas` calculation with token price conversion
3. **Gas cut** — `gas-cut.ts`: gas cost estimation in sell token
4. **Penalty** — `penalty.ts`: Track A penalty amounts (gas + c_l for reverts, 0.1×c_l for non-settlement)
5. **Audit** — `audit.ts`: audit event types (StatusChanged, Awarded, etc.)
6. **Order** — `order.ts`: order validation envelope types
7. **Validator** — `validator.ts`: validation interface/type (seam between domain and infra)

**Rust reference:** `crates/byos/src/domain/`

**Tests:** Unit tests for scoring, gas cut calculation, penalty amounts, state transition validity. These should be direct ports of the Rust unit tests.

### Phase 3 — Database Layer (`apps/byos/src/infra/storage.ts`)

Set up Drizzle schema and the proposal store.

**Deliverables:**
1. **Drizzle schema** — `src/db/schema.ts`: `proposals`, `auditEvents`, `solutions`, `penalties` tables matching the final Rust schema (after all 6 migrations)
2. **Migrations** — `drizzle-kit generate` from schema
3. **Proposal store** — `infra/storage.ts`: CRUD operations
   - `insert(proposal)` — create as Submitted
   - `findById(id, subSolver?)` — owner-scoped read
   - `findByOrderUid(orderUid, subSolver?)` — owner-scoped list
   - `findBySubSolver(subSolver)` — active proposals
   - `findActiveByOrderUids(orderUids)` — for /solve (batch read)
   - `updateStatus(id, status, reason?)` — state transitions
   - `deleteTerminal(olderThan)` — retention sweep
4. **Audit store** — `infra/audit.ts`: append-only event writer
5. **Test harness** — `test/setup.ts`: unique DB per test, migration runner, cleanup

**Rust reference:** `crates/byos/migrations/`, `crates/byos/src/infra/storage.rs`, `crates/byos/src/infra/audit.rs`, `crates/byos/src/tests/setup/`

**Tests:** Service-level tests — proposal CRUD, state transitions, owner scoping, audit event emission.

### Phase 4 — Blockchain Layer (`apps/byos/src/infra/blockchain/`)

Port all chain interactions using viem.

**Deliverables:**
1. **Escrow** — `escrow.ts`: `getBalance(subSolver)` via `readContract`
2. **Simulation** — `simulation.ts`: `eth_estimateGas` with full `settle()` calldata and state overrides
3. **Operator** — `operator.ts`: `debit()` call signed by operator wallet (viem `walletClient`)
4. **Validator** — `validator.ts`: combines escrow check + simulation, returns validation result
5. **Orderbook client** — `orderbook.ts`: fetch order by UID, fetch token prices

**Rust reference:** `crates/byos/src/infra/blockchain/`, `crates/byos/src/infra/orderbook.rs`

**Tests:** Unit tests with mocked RPC responses (vitest mocking or msw).

### Phase 5 — API Layer (`apps/byos/src/infra/api/`)

Wire up Hono routes and middleware.

**Deliverables:**
1. **Public Hono app** (port 9585):
   - `POST /proposals` — Zod-validated body, EIP-712 signature verify, store as Submitted, return 202
   - `GET /proposal/:id` — `X-Signature` auth, owner-scoped read
   - `GET /proposals/:orderUid` — `X-Signature` auth, owner-scoped list
   - `GET /proposals/by-sub-solver` — `X-Signature` auth, list caller's active proposals
   - `DELETE /proposal/:id` — `X-Signature` CancelProposal auth
   - `GET /healthz` — 200 OK
2. **Internal Hono app** (port 9586):
   - `POST /solve` — Bearer token auth, auction processing, proposal ranking, solution response
   - `POST /notify` — Bearer token auth, settlement outcome processing
   - `GET /healthz` — 200 OK
3. **Middleware:**
   - Bearer token auth middleware for internal routes
   - EIP-712 signature extraction middleware for public routes
   - Redis-backed rate limiting middleware for public routes
   - Error handler (`app.onError`) mapping `AppError` to JSON responses
   - Request logging via pino
4. **DTO conversion** — `dto.ts`: Zod schemas → domain types, domain types → response JSON

**Rust reference:** `crates/byos/src/infra/api/`

**Tests:** Route-level tests with test `AppContext`, covering auth, validation errors, happy paths.

### Phase 6 — Background Jobs & Startup

Wire the service together using BullMQ for background work and Redis as the job store.

**Deliverables:**
1. **Redis connection** — `infra/jobs/index.ts`: shared `IORedis` connection for all queues and workers
2. **Validation job** — `infra/jobs/validation.ts`: BullMQ repeatable tick every 12s releases stale Executing proposals, expires past-`validUntil` ones, and enqueues one `byos:validate-proposal` job per remaining live proposal (job id deduped per proposal). A second worker processes those jobs with concurrency 8, matching the Rust loop's semaphore bound on RPC bursts; each job re-reads the proposal from Postgres, runs escrow + simulation, and transitions it to Active/Rejected/SimFailed.
3. **Retention sweep job** — `infra/jobs/retention.ts`: BullMQ repeatable job every 5m, deletes terminal proposals older than retention window
4. **Penalty job** — `infra/jobs/penalty.ts`: BullMQ repeatable job, processes Track A debits for SettleFailed proposals
5. **Audit trail** — `infra/audit.ts`: BullMQ queue for durable write-behind. Audit events are enqueued (survives crashes) and a worker drains them to Postgres. Replaces the Rust in-memory channel approach with a persistent queue.
6. **Rate limiter** — `infra/rate-limit.ts`: Redis-backed sliding window rate limiter for the public `/proposals` API
7. **AppContext builder** — `context.ts`: constructs DB pool, Redis connection, viem clients, BullMQ queues, config. Passed to apps and workers.
8. **Entry point** — `index.ts`: Zod config parsing, context creation, start both HTTP servers, start BullMQ workers, `AbortController` for HTTP shutdown, `SIGTERM`/`SIGINT` handlers
9. **Graceful shutdown order:** signal abort → close HTTP servers → `worker.close()` on all BullMQ workers (finishes current job) → drain audit queue → close Redis connection → close DB pool

**Rust reference:** `crates/byos/src/run.rs`, `crates/byos/src/infra/validation.rs`, `crates/byos/src/infra/retention.rs`, `crates/byos/src/infra/penalty.rs`

**Tests:** Startup/shutdown tests, job scheduling behavior, audit queue durability.

### Phase 7 — Subsolver (`apps/subsolver`)

Port the reference sub-solver.

**Deliverables:**
1. **Config** — `config.ts`: Zod-validated env vars (BYOS URL, RPC URL, private key, etc.)
2. **Domain** — `domain/proposal.ts`, `domain/routing.ts`
3. **BYOS client** — `infra/byos.ts`: HTTP client for the proposal API using fetch
4. **Orderbook client** — `infra/orderbook.ts`: order discovery
5. **Blockchain** — `infra/blockchain.ts`: viem for signing, token operations
6. **Entry point** — `index.ts`: poll orderbook → compute routes → sign proposals → submit to BYOS → poll for status

**Rust reference:** `crates/subsolver/`

### Phase 8 — E2E Tests (`tests/e2e`)

Port integration tests.

**Deliverables:**
1. **Chain fixture** — `src/chain.ts`: anvil setup with deployed contracts
2. **E2e test cases** — full proposal lifecycle through both services
3. **Docker Compose overlay** for offline-mode (if needed)

**Rust reference:** `crates/e2e/`, `offline-mode/`, `dev/offline-mode/`

### Phase 9 — Documentation & Polish

**Deliverables:**
1. **ADRs** — copy domain ADRs (0001-0003, 0005, 0007, 0010-0013), write new TS-specific ADRs replacing 0004 (workspace), 0006 (config), 0008 (observability), 0009 (testing), 0014 (artifacts)
2. **OpenAPI spec** — copy `openapi.yml`, add linting to CI
3. **README.md** — development setup, running locally, testing
4. **`docs/reference/`** — copy from Rust repo (protocol-agnostic)

## Cross-Cutting Patterns

### Error Handling

```typescript
// Single error class with kind discrimination
enum Kind {
  InvalidSignature = "InvalidSignature",
  SignatureRecoveryFailed = "SignatureRecoveryFailed",
  InsufficientEscrow = "InsufficientEscrow",
  ProposalExpired = "ProposalExpired",
  ProposalLifetimeExceeded = "ProposalLifetimeExceeded",
  ProposalNotFound = "ProposalNotFound",
  ProposalNotCancellable = "ProposalNotCancellable",
  BadRequest = "BadRequest",
  Internal = "Internal",
}

class AppError extends Error {
  constructor(
    public readonly kind: Kind,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}
```

### Configuration

```typescript
// Zod schema for env vars, fail-fast at startup
const configSchema = z.object({
  DATABASE_URL: z.string(),
  CHAIN_ID: z.coerce.number(),
  TRAMPOLINE_FACTORY: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  PUBLIC_ADDR_PORT: z.coerce.number().default(9585),
  INTERNAL_ADDR_PORT: z.coerce.number().default(9586),
  RPC_URL: z.string().url().optional(),
  // ... etc
});
```

### Background Jobs (BullMQ)

Background work uses BullMQ repeatable jobs backed by Redis. This replaces the Rust service's `tokio::spawn` + `tokio::time::interval` pattern.

```typescript
import { Queue, Worker } from "bullmq";
import type { IORedis } from "ioredis";

// Queue setup — one per job type
const validationQueue = new Queue("validation", { connection: redis });

// Add a repeatable job (runs every 12s)
await validationQueue.upsertJobScheduler("validation-loop", {
  every: 12_000,
});

// Worker processes jobs
const validationWorker = new Worker("validation", async (job) => {
  const submitted = await store.findByStatus("submitted");
  await Promise.all(submitted.map((p) => validate(p)));
}, { connection: redis });

// Graceful shutdown
await validationWorker.close(); // finishes current job, then stops
```

Key differences from the Rust approach:
- Jobs are **durable** — if the process crashes mid-tick, the job is retried on restart
- BullMQ handles **scheduling** — no manual `setTimeout` or `setInterval`
- **Concurrency** is configurable per worker (`concurrency: 1` by default — no overlapping ticks)
- `worker.close()` provides clean shutdown (finishes current job, stops accepting new ones)

### Audit Trail (BullMQ Queue)

The audit trail uses a dedicated BullMQ queue for durable write-behind persistence. Events survive process crashes (unlike the Rust in-memory channel).

```typescript
const auditQueue = new Queue("audit", { connection: redis });

// Enqueue from anywhere (fire-and-forget)
await auditQueue.add("status-changed", { proposalId, from, to, timestamp });

// Worker drains to Postgres
const auditWorker = new Worker("audit", async (job) => {
  await db.insert(auditEvents).values(job.data);
}, { connection: redis });
```

> **Note:** Audit jobs should be configured with retry-forever semantics (high attempt count with exponential backoff, `removeOnFail: false`) to match the Rust service's behavior where audit events are never dropped. The audit worker should also be the last worker closed during graceful shutdown, since other workers may enqueue audit events during their teardown.

### Rate Limiting (Redis)

Public API rate limiting uses a Redis-backed sliding window, replacing the Rust service's in-memory `tower::limit`.

```typescript
// Redis sliding window — survives restarts, ready for multiple instances
async function checkRateLimit(key: string, limit: number, windowSecs: number): Promise<boolean> {
  const current = await redis.incr(key);
  if (current === 1) await redis.expire(key, windowSecs);
  return current <= limit;
}
```

### BigInt Boundaries

```typescript
// Zod transform at API boundary
const decimalBigInt = z.string().transform((s) => BigInt(s));

// DB boundary: Drizzle custom type or explicit conversion
// Store as TEXT, read/write with BigInt conversion helpers
function bigintToDecimal(n: bigint): string { return n.toString(); }
function decimalToBigint(s: string): bigint { return BigInt(s); }
```

### CoW SDK Usage (`@cowprotocol/cow-sdk`)

The `@cowprotocol/cow-sdk` provides standard CoW Protocol types and utilities. We use it where types are identical to avoid drift. BYOS-specific types (Proposal, EIP-712 schemas, trampoline encoding) stay manual.

**Used from cow-sdk:**

| cow-sdk export | Used in | Replaces |
|----------------|---------|----------|
| `OrderKind` (`SELL`, `BUY`) | `settlement.ts`, re-exported from `index.ts` | Manual `OrderKind` enum |
| `BUY_ETH_ADDRESS` | Re-exported from `index.ts` | Manual constant |
| `SupportedChainId` | Re-exported from `index.ts`, config validation | Manual chain ID enum |
| `OrderSigningUtils` | `apps/subsolver` (future) | Manual order signing |
| `computeOrderUid` | `apps/subsolver` (future) | Manual UID computation |

**Kept manual (not identical to cow-sdk):**

| Our type | Why not cow-sdk | Difference |
|----------|----------------|------------|
| `SigningScheme` (string enum) | cow-sdk uses numeric (0,1,2,3) | Orderbook API returns string values (`"eip712"`, `"ethsign"`, etc.) |
| `CowOrder` interface | cow-sdk `Order` lacks `signingScheme` and `signature` fields | Those fields are separate in cow-sdk's model |
| `Proposal`, `ContractInteraction` | BYOS-specific on-chain structs | Not part of CoW Protocol |
| EIP-712 types (ProposalData, CancelProposal, ReadAuth) | BYOS domain, not CoW order domain | Different EIP-712 schema entirely |
| All DTOs (`dto.ts`) | BYOS proposal API, not CoW orderbook API | Different API contract |

## Dependencies

### Root devDependencies (shared tooling)
- `@biomejs/biome`
- `typescript`
- `tsup`
- `vitest`

### packages/common
- `@cowprotocol/cow-sdk`
- `viem`
- `zod`

### apps/byos
- `hono`
- `@hono/node-server`
- `drizzle-orm`
- `postgres` (porsager) or `pg`
- `bullmq`
- `ioredis`
- `pino`
- `zod`
- `dotenv`
- Dev: `drizzle-kit`, `vitest`, `@types/node`

### apps/subsolver
- `hono` (if it exposes any HTTP)
- `viem`
- `pino`
- `zod`
- `dotenv`
