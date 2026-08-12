# On-chain e2e tests

Settlement tests that deploy BYOS contracts to a local Anvil instance and
verify that encoded settlement calldata is accepted by the real GPv2Settlement
contract.

## What's tested

| Test | Status |
|------|--------|
| Chain fixture boots with BYOS contracts | Implemented |
| Partial fill settlement (50% + 30%) | Implemented |
| Hooks settlement via HooksTrampoline | Placeholder (TODO) |
| Partial fills with hooks | Placeholder (TODO) |

## Prerequisites

1. **Anvil** -- install via [Foundry](https://book.getfoundry.sh/getting-started/installation):
   ```sh
   curl -L https://foundry.paradigm.xyz | bash
   foundryup
   ```

2. **Offline-mode state file** -- the tests load Anvil with a pre-built chain
   state that contains GPv2Settlement, WETH, USDC, and other contracts at
   their mainnet addresses. The state file lives in the [byos-service](https://github.com/bleu/byos-service) repo:
   ```sh
   cd ../byos-service
   git submodule update --init
   ```
   Alternatively, set `ANVIL_STATE_PATH` to the absolute path of
   `anvil-state.json`.

3. **Contract artifacts** -- the Escrow bytecode is vendored in
   `tests/onchain/artifacts/Escrow.json` (sourced from
   [byos-contracts](https://github.com/bleu/byos-contracts)). The HooksTrampoline
   bytecode is in `artifacts/HooksTrampoline.json`.

## Running

Tests are **skipped by default** -- they require Anvil and the state file.
Enable them with:

```sh
RUN_ONCHAIN_TESTS=1 pnpm vitest run --project onchain
```

Or run them in watch mode:

```sh
RUN_ONCHAIN_TESTS=1 pnpm vitest --project onchain
```

## Architecture

```
tests/onchain/
  artifacts/        # Contract bytecode artifacts (Escrow, HooksTrampoline)
  src/
    chain.ts        # Anvil spawner + Escrow CREATE2 deployment
    settlement.test.ts  # Settlement verification tests
```

The chain fixture:
1. Strips transaction history from the state file (so any Anvil version works)
2. Spawns Anvil on a random free port with `--load-state`
3. Deploys the Escrow via the CREATE2 singleton factory (which also deploys
   TrampolineFactory)
4. Returns client handles and addresses for the tests to use

## What's still needed for hooks tests

The hooks settlement tests (`it.todo`) need:
- HooksTrampoline deployment via CREATE2 (bytecode is available in artifacts)
- EIP-2612 permit signing for USDC (to grant vault-relayer allowance via pre-hook)
- Settlement calldata with pre/post interactions routed through HooksTrampoline
