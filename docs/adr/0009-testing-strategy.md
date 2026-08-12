# ADR-0009: Testing Strategy

**Status:** Accepted

## Context

The service needs multi-tier test coverage: fast unit tests, database-backed integration tests, and end-to-end tests that exercise the full API.

## Decision

**Vitest** with three workspace projects: `unit`, `db`, `e2e`.

### Test tiers

| Tier | Vitest project | File pattern | Requires | Command |
|------|---------------|--------------|----------|---------|
| Unit | `unit` | `*.test.ts` (excludes `*.db.test.ts`) | Nothing | `pnpm test` |
| DB | `db` | `*.db.test.ts` | Postgres | `pnpm test:db` |
| E2E | `e2e` | `tests/e2e/src/*.test.ts` | Postgres | `pnpm test` (included in default) |

### Database isolation

Each DB test gets a **unique Postgres database** (`byos_test_{pid}_{timestamp}_{counter}`):
- No test interdependence
- Tests can run in parallel safely
- Stale databases older than 3 hours are swept automatically

### E2E test approach

E2e tests use **Hono's `app.request()` test client** with a real Postgres database but no HTTP server binding. The service is tested in-process:
- `createTestApp()` builds an AppContext with AcceptAll validator
- Proposals are submitted, polled, and cancelled through the Hono apps
- DB state is seeded directly for /solve and /notify tests

This avoids the overhead of starting/stopping HTTP servers and manages port conflicts.

### What's NOT tested here

- Settlement mechanics on GPv2 (requires anvil + contract state — covered by the on-chain test tier)
- Full driver integration (requires offline-mode docker stack)
- Escrow balance checks with real RPC (covered by the simulation validator's integration with anvil)

### CI

The `test.yml` workflow runs all three tiers:
1. `pnpm build` (compilation check)
2. `pnpm test` (unit + e2e, Postgres available via service container)
3. `pnpm test:db` (DB-tier tests)
