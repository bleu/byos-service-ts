# ADR-0009: Testing Strategy

**Status:** Accepted

## Context

The service needs multi-tier test coverage: fast unit tests, database-backed integration tests, and end-to-end tests that exercise the full API.

## Decision

**Vitest** with three workspace projects: `unit`, `db`, `e2e`.

### Test tiers

| Tier | Vitest project | File pattern | Requires | Command |
|------|---------------|--------------|----------|---------|
| Unit | `unit` | `*.test.ts` (excludes `*.db.test.ts` and `*.redis.test.ts`) | Nothing | `pnpm test` |
| DB | `db` | `*.db.test.ts` | Postgres | `pnpm test:db` |
| Redis | `redis` | `*.redis.test.ts` | Redis | `pnpm test:redis` |
| E2E | `e2e` | `tests/e2e/src/*.test.ts` | Postgres | `pnpm test` (included in default) |

### Database isolation

Each DB test gets a **unique Postgres database** (`byos_test_{pid}_{timestamp}_{counter}`):
- No test interdependence
- Tests can run in parallel safely
- Stale databases older than 3 hours are swept automatically

### Redis isolation

Redis tests share one database rather than creating their own, so each test namespaces its keys with a `byos:test:{pid}:{timestamp}:{counter}` prefix and sweeps that prefix afterwards. The rate limiter and balance cache take the prefix as an option for exactly this reason.

The tier exists because the key layout, TTLs, and two-window arithmetic are where sliding-window bugs live — a faked Redis would exercise none of them.

### E2E test approach

E2e tests use **Hono's `app.request()` test client** with a real Postgres database but no HTTP server binding. The service is tested in-process:
- `createTestApp()` builds an AppContext with AcceptAll validator, the `allowAll` limiter, and the `unknownBalances` cache
- Proposals are submitted, polled, and cancelled through the Hono apps
- DB state is seeded directly for /solve and /notify tests

This avoids the overhead of starting/stopping HTTP servers and manages port conflicts.

### What's NOT tested here

- Settlement mechanics on GPv2 (requires anvil + contract state — covered by the on-chain test tier)
- Full driver integration (requires offline-mode docker stack)
- Escrow balance checks with real RPC (covered by the simulation validator's integration with anvil)

### CI

The `test.yml` workflow runs all four tiers:
1. `pnpm build` (compilation check)
2. `pnpm test` (unit + e2e, Postgres available via service container)
3. `pnpm test:db` (DB-tier tests)
4. `pnpm test:redis` (Redis-tier tests)
