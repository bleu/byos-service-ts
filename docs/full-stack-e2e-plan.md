# Full-Stack E2E Testing Plan

## Goal

Add tier-2 (full-stack) e2e tests to `byos-service-ts` that exercise the real CoW Protocol integration: real autopilot cutting auctions, real driver calling `/solve`, settlements landing on Anvil, and `/notify` delivering outcomes. This is the only tier that validates ADR-0002's claim that BYOS is a vanilla solver engine behind a standard, unmodified driver.

Tests must be **locally stateless**: no accumulated host state, deterministic initial conditions from a committed `anvil-state.json`, identical results on any machine.

Scenarios start with a happy path and grow to cover adversarial cases: spam attacks, malicious proposals, malformed orders, Track A penalty flows, concurrent proposals, and cancellation during settlement.

## Related Linear issues

| Issue | Status | Relevance |
|-------|--------|-----------|
| COW-1165 | Todo | Parent — defines tier-1 (in-process anvil) and tier-2 (full stack) e2e structure |
| COW-1236 | Done | Stack bring-up (compose overlay, solver whitelist, Escrow deploy, account map). Done in the **Rust repo** — needs TS equivalent. |
| COW-1124 | Canceled | Scenario list: happy paths, malicious sub-solvers, malformed orders, Track A/B, spam. Intent is exactly what we want to revive here. |
| COW-1237 | In Progress | Bake BYOS solver + Escrow into `anvil-state.json` for deterministic boot. Directly supports the "locally stateless" property. |
| COW-1240 | In Progress | Verify driver fee transform on a settled trade. Manual, not automated — but needs the same stack with `FEE_POLICIES` configured. |

## Offline-mode: custom branch

Use a **custom branch** of the `cowdao-grants/offline-mode` submodule, added directly to this repo.

### Strip (not needed for automated tests)

- `frontend` (CoWswap UI)
- `explorer` (block explorer)
- `grafana` / `prometheus` / `tempo` (observability stack)
- `watch-tower` (ComposableCow conditional orders — unless testing conditional orders)

### Keep (required)

- `chain` (Anvil with pre-deployed GPv2 contracts)
- `chain-deployer` (state preparation)
- `db` (Postgres for orderbook)
- `db-migrations` (Flyway)
- `orderbook` (accepts user orders via REST)
- `autopilot` (runs auctions every ~2s, cuts orders for solvers)
- `driver` (calls `/solve`, broadcasts settlements, sends `/notify`)
- `baseline` (reference solver / competitor)
- `coingecko-mock` (local price feed from Uniswap V2 pools)
- `block-miner` (mines blocks every 2s)

### Add / modify

- Bake BYOS solver whitelist + Escrow into `anvil-state.json` (COW-1237) so no per-boot anvil cheats are needed.
- Optionally add `FEE_POLICIES` to autopilot env (COW-1240) for fee-related scenarios.

## Proposed structure

```
byos-service-ts/
  offline-mode/              <- git submodule (custom branch)
  docker-compose.e2e.yml     <- overlay: adds TS BYOS container, overrides driver/autopilot config
  tests/full-stack/
    src/
      helpers/
        chain.ts             <- evm_snapshot / evm_revert, fund, approve
        orderbook.ts         <- sign GPv2 orders, POST to orderbook API
        polling.ts           <- wait for proposal status, tx receipts, etc.
      happy-path.test.ts
      malicious.test.ts
      spam.test.ts
      ...
    package.json
    tsconfig.json
  vitest.config.ts            <- add "full-stack" project
```

## Compose overlay (`docker-compose.e2e.yml`)

Extends the offline-mode stack and adds the TS BYOS service:

- **BYOS container**: built from a Dockerfile in this repo (Node.js multi-stage build), exposes public (9585) and internal (9586) ports on the docker network.
- **Driver config override**: mounts a `driver.toml` with a `[[solver]]` block pointing to `http://byos:9586`.
- **Autopilot DRIVERS override**: adds `byos|http://driver/byos|<solver-address>` alongside baseline.

## State isolation between tests

- **Chain**: `evm_snapshot` at suite start, `evm_revert` between tests. No container restarts.
- **BYOS database**: truncate or recreate tables between tests (the BYOS Postgres is separate from orderbook's).
- **Orderbook**: state accumulates in its Postgres but should not interfere across tests if each test uses unique trader accounts / order UIDs. If it does, add a truncate step.

## Account map (from COW-1236)

| Role | Anvil account |
|------|---------------|
| Baseline solver (already whitelisted in state) | 0 |
| BYOS settlement submitter | 3 |
| Escrow operator (Track A debits) | 1 |
| Escrow admin | 2 |
| Sub-solver (escrow depositor + proposal signer) | 4 |
| Trader | 5 |

## Happy-path test flow

```
1. evm_snapshot
2. Fund trader (account 5) with WETH, approve VaultRelayer
3. POST order to orderbook (sell WETH for USDC)
4. Wait for autopilot auction cycle (~2-4s)
5. Assert: BYOS received /solve, created a proposal
6. Assert: driver settled on-chain (check tx receipt)
7. Assert: /notify delivered settlement outcome, proposal status updated
8. evm_revert
```

## Adversarial scenarios (from COW-1124)

- **Spam**: N proposals per auction from multiple sub-solvers; assert service stays responsive and picks the best.
- **Malicious proposals**: bad calldata, inflated amounts, approval backdoors, reentrancy attempts; assert filtered and penalized.
- **Malformed orders**: invalid EIP-712 signatures, mismatched `interactionsHash`, expired `validUntil`.
- **Non-profitable orders**: proposals producing less than `buyAmount`; assert atomic revert, no buffer drain.
- **Track A**: reverted settlement -> escrow debit, attribution via Trampoline CREATE2 address.
- **Cancellation during settlement**: cancel while driver is encoding; assert no double-settlement.
- **Concurrent proposals**: same sub-solver, same order; assert correct deduplication.
- **Race conditions**: proposal submitted right as auction closes.

## Open questions

- **BYOS as container vs. host process?** Container is more portable and truly stateless. Host process is faster to iterate on during development. Could support both (container for CI, host for dev).
- **BYOS winning auctions**: on the same Uniswap V2 pool, the reference sub-solver routes identically to baseline but pays extra gas through the Trampoline, so BYOS should score lower. Adversarial scenarios requiring BYOS to win need either baseline out of the auction or a sub-solver with a routing edge.
- **CI feasibility**: the offline-mode stack takes 20-60 min to build cold. Pre-built images or a CI cache strategy would be needed for per-PR runs. Nightly/staging may be more practical initially.
