# End-to-end test guide

This document describes how to run, maintain, and extend the e2e tests.

## What the e2e tests do

The e2e tests run the full settlement cycle on a local Anvil chain:

1. A trader submits a GPv2 order to the orderbook.
2. A sub-solver submits a BYOS proposal with Uniswap V2 interactions.
3. The BYOS service validates the proposal through simulation.
4. The autopilot sends an auction to the driver.
5. The driver calls `/solve` on the BYOS service and gets a solution.
6. The driver settles the solution on-chain.
7. The test verifies that the trader received tokens.

All services run in Docker. The chain is a local Anvil fork with baked contract state.

## Prerequisites

You must install these tools before you run the tests:

- Docker Desktop (or Docker Engine + Compose plugin)
- Node.js 22+
- pnpm 10+
- Foundry (`anvil` and `cast` on PATH — install with `foundryup`)

## How to run

### Start the stack

```bash
pnpm e2e:up
```

This command does two things:

1. It bakes the BYOS contracts (Escrow + TrampolineFactory) into the Anvil state.
2. It starts all Docker containers and waits until they are healthy.

The script writes the contract addresses to `.env.e2e`. The BYOS service and the test helpers read addresses from this file. You do not need to update addresses manually.

### Run the tests

```bash
pnpm test:e2e
```

### Stop the stack

```bash
pnpm e2e:down
```

This command removes all containers and volumes.

### Reset the stack

If you change contract bytecode, constructor arguments, or Docker configuration:

```bash
pnpm e2e:down && pnpm e2e:up
```

## Architecture

### Services

The e2e stack uses two Docker Compose files:

| File | Purpose |
|------|---------|
| `offline-mode/docker-compose.yml` | Base CoW Protocol stack (chain, orderbook, autopilot, driver) |
| `docker-compose.e2e.yml` | BYOS overlay (byos-ts, byos-db, byos-redis, driver config) |

The `scripts/e2e-stack.sh` script combines these two files into one stack.

### Contract deployment

The deploy script (`offline-mode/scripts/byos/deploy-byos-contracts.sh`) does these steps:

1. It starts a temporary Anvil instance on port 18545.
2. It loads the existing chain state from `offline-mode/state/anvil-state.json`.
3. It deploys the Escrow contract through the CREATE2 factory.
4. The Escrow constructor deploys the TrampolineFactory automatically.
5. It whitelists the BYOS solver in GPv2Authenticator.
6. It dumps the updated state back to `anvil-state.json`.

The Escrow bytecode comes from `offline-mode/scripts/byos/artifacts/Escrow.json`. This artifact is built from the [byos-contracts](https://github.com/bleu/byos-contracts) repository.

### Address management

Contract addresses are deterministic (CREATE2 with a zero salt). They change when the Escrow bytecode or constructor arguments change.

The `e2e-stack.sh` script handles this automatically:

1. It runs the deploy script on every `pnpm e2e:up`.
2. It parses the Escrow and TrampolineFactory addresses from the deploy output.
3. It writes the addresses to `.env.e2e`.
4. Docker Compose injects these addresses into the `byos-ts` container.
5. Vitest loads the same file for the test helpers.

The `.env.e2e` file is gitignored. You do not commit it.

### Anvil accounts

All accounts come from the standard Anvil mnemonic: `test test test test test test test test test test test junk`.

| Index | Role | Address |
|-------|------|---------|
| 0 | Baseline solver / token deployer | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| 1 | Escrow operator | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| 2 | Escrow admin | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` |
| 3 | BYOS solver (submitter) | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` |
| 4 | Sub-solver | `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` |
| 5 | Trader | `0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc` |

## How to update the Escrow artifact

Do these steps when the Solidity contracts change:

1. Build the contracts in the `byos-contracts` repository:
   ```bash
   cd ../byos-contracts
   forge build
   ```

2. Copy the artifact:
   ```bash
   node -e "
     const fs = require('fs');
     const forge = JSON.parse(fs.readFileSync('../byos-contracts/out/Escrow.sol/Escrow.json','utf8'));
     const artifact = { abi: forge.abi, bytecode: forge.bytecode };
     fs.writeFileSync('offline-mode/scripts/byos/artifacts/Escrow.json', JSON.stringify(artifact, null, '\t') + '\n');
   "
   ```

3. Reset the stack:
   ```bash
   pnpm e2e:down && pnpm e2e:up
   ```

The script re-bakes the state and updates `.env.e2e` with the new addresses. No manual address edits are necessary.

## How to add a new test

1. Add a new test file in `tests/e2e/src/`.
2. Use the helpers from `tests/e2e/src/helpers/`:
   - `config.ts` — contract addresses, account keys, RPC URLs
   - `orderbook.ts` — sign orders, fund tokens, poll for execution
   - `byos.ts` — sign and submit proposals, poll for status
   - `chain.ts` — snapshot and revert chain state
3. Run `pnpm test:e2e` to verify.

Each test should take a chain snapshot in `beforeAll` and revert it in `afterAll`. This keeps the chain state clean between tests.

## Troubleshooting

### The test times out

The test has a 120-second timeout. If it times out:

1. Check the driver logs for errors:
   ```bash
   pnpm e2e:down  # not needed if stack running
   pnpm e2e:up
   pnpm test:e2e
   docker compose -f offline-mode/docker-compose.yml -f docker-compose.e2e.yml logs driver 2>&1 | grep WARN
   ```

2. Common causes:
   - The `/solve` response format does not match what the driver expects.
   - The settlement simulation reverts (check for `custom error` in driver logs).
   - The BYOS validation tick has not processed the proposal yet.

### `ESCROW_ADDRESS not set` error

Run `pnpm e2e:up` first. This command generates the `.env.e2e` file.

### Settlement reverts with `Trampoline_UnauthorizedSubmitter`

The BYOS solver does not have `SUBMITTER_ROLE` on the Escrow. Reset the stack:

```bash
pnpm e2e:down && pnpm e2e:up
```

### Addresses changed after artifact update

This is expected. The CREATE2 address depends on the Escrow bytecode and constructor arguments. The `e2e-stack.sh` script updates `.env.e2e` automatically on every `pnpm e2e:up`. No manual changes are necessary.
