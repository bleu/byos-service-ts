# Simulation

Status: accepted; revised 2026-10-01 (eth_simulateV1, simulationBuyAmount, slippage gap check)

Spec: docs/shared/design-document.md#simulation
      https://bleu.github.io/byos-docs/design-document#simulation

## Context

This ADR settles how proposals are simulated, how the gas result flows into scoring, and the continuous re-validation of active proposals.

Depends on: [ADR-0001](0001-proposal-api.md) (proposal lifecycle), [ADR-0002](0002-solver-engine.md) (solver engine scoring), [ADR-0019](0019-slippage-protection.md) (slippage gap check).

The design was proven end-to-end by a mainnet fork spike (COW-1181, 2026-07-27): a real orderbook order was settled through a freshly deployed trampoline from an unprivileged sender using only the two state overrides below.

## Decision

The simulation dispatch shape (`settle()` from a dummy submitter with two state overrides), the validation envelope, and the continuous re-validation loop are specified in the design document (see Spec link above). This ADR records the rationale and implementation-specific details.

### Why a full `settle()` simulation

Because the order is real, the user has genuinely approved the vault relayer and holds the sell tokens — no balance faking, no allowance faking, no per-token storage-slot detection. Everything runs at real addresses, so the trampoline's floor-and-sweep semantics behave exactly as production, and GPv2's own checks come along for free.

### RPC method: eth_simulateV1

Since COW-1297, simulation uses `eth_simulateV1` (Geth's `blockStateCalls` API) instead of `eth_estimateGas`. The reasons:

1. **Event logs are available.** `eth_simulateV1` returns the logs emitted during simulation, including the Trampoline's `Executed(_orderUidHash, _delta, _floor, _ceiling)` event. `_delta` is the actual buy-token amount the route delivered to the settlement — the authoritative simulation result that backs the clearing price.
2. **Revert data is always present.** Reverts return `call.status == "0x0"` with revert data in `call.returnData` (and `call.error.data` as a fallback), giving a readable revert reason for debugging.
3. **Same trip count.** A single `eth_simulateV1` replaces a single `eth_estimateGas`.

The `stateOverrides` map in `eth_simulateV1` uses the Geth object format `{ [address]: { code?, stateDiff: { [slot]: value } } }` — stateDiff is an object keyed by slot, not an array.

### simulationBuyAmount: the effective clearing price

`simulationBuyAmount` is the `_delta` field from the Trampoline `Executed` event — the buy-token amount the route actually delivered during simulation. It is stored on the proposal and used as the effective clearing price at `/solve` time:

```
effectiveBuyAmount = min(simulationBuyAmount, quoteBuyAmount)
```

Using the minimum guards against two failure modes:
- **Route over-promise**: if the simulation delivered less than `quoteBuyAmount`, the clearing price was inflated. Using `simulationBuyAmount` corrects it.
- **Route improvement**: if the simulation delivered more than `quoteBuyAmount`, the sub-solver already committed to `quoteBuyAmount` on-chain and the extra tokens stay in the settlement as BYOS-owned slippage. The min keeps the commitment semantics intact.

`effectiveBuyAmount` is used everywhere a clearing-price commitment is needed: `/solve` scoring, fill-constraint checks, and the clearing price array returned to the driver.

A missing `Executed` event (log not emitted during simulation) rejects the proposal with `SimulationMissingExecutedEvent` — treated as a simulation failure. A proposal with `simulationBuyAmount = null` (pre-feature row or escrow-only rejection) falls back to `quoteBuyAmount`.

### Gap check: pre-simulation slippage guard

Before dispatching `eth_simulateV1`, the validator runs a cheap gap check that rejects proposals where `minBuyAmount` is too far below `quoteBuyAmount` ([ADR-0019](0019-slippage-protection.md)). This catches routes committing to large negative-slippage executions before they consume an RPC slot.

### What the simulation does not model

The encoder sets `executedAmount` to the proposal's fill amount and `clearingPrices` to `[quoteBuyAmount, sellAmount]`. The driver's real transaction subtracts the gas cut and substitutes its own per-trade prices, then applies protocol fees. Neither is threaded through the encoder: the gas is the same (same tokens, same interactions, same trade, same storage touched), and the divergence is one-directional — the real transaction pays the user less than the simulated one, never more.

### The two state overrides

- **Authenticator** (resolved once via `settlement.authenticator()`, cached): code override with `AnyoneAuthenticator`, so any `from` passes the solver allowlist.
- **Escrow**: a `state_diff` write granting `SUBMITTER_ROLE` to the dummy. The Escrow inherits **non-upgradeable** OpenZeppelin v5 `AccessControl`, so `_roles` lives at plain storage slot 5: the slot is `keccak256(pad32(account) ++ keccak256(pad32(role) ++ pad32(5)))`. This is NOT the ERC-7201 namespaced slot the upgradeable variant uses.

Once a production submitter address holds `SUBMITTER_ROLE` on-chain, both overrides become unnecessary.

### Order data: fetched from the orderbook, cached forever

Orders are immutable once placed, so fetches are cached for the process lifetime. `POST /proposals` does NOT carry token addresses. Known staleness: an off-chain soft-cancel is invisible, but `validUntil` bounds the window and the driver re-validates at settlement time.

### Gas in scoring: simulated gas + 30k buffer

Gas comes from `call.gasUsed` in the `eth_simulateV1` response. The 30k buffer is unchanged: the full-settle estimate already covers intrinsic gas and the entire settlement path, so it only absorbs warm/cold storage differences and driver batching variance. Proposals without `gas_used` (not yet simulated) are skipped by `/solve`.

### Trampoline resolution

`TrampolineFactory.addressOf(sub_solver)` at validation time, cached per sub-solver (CREATE2 addresses are deterministic and never change).

### Hooks

Order hooks are included in simulation for accurate gas estimates (COW-1243). The `/solve` response does NOT include hooks — the driver appends them itself. **Known trade-off:** gas is overestimated for non-first fills of hooked orders because the order cache always includes pre-interactions.

### Error handling: defer on transport errors, fail on reverts

- **Simulation reverts** (`call.status == "0x0"`): proposal is permanently dropped with `SimFailed`.
- **Missing Executed event**: rejected with `SimulationMissingExecutedEvent` (terminal).
- **Transport errors** (RPC timeout, DNS failure): deferred, retried next tick.
- **Trampoline resolution errors**: same deferral policy.
- **Orderbook errors**: order 404 rejects (`OrderNotFound`); buy-token price 404 on a sell order rejects (`ProposedSlippageOutrange` — cannot assess the gap); transient errors defer.

## Alternatives rejected

### A. Settlement calls itself with a fake `settle()`

Rejected: users approve the **VaultRelayer**, not the settlement, so the `transferFrom` reverts on real mainnet state.

### B. ERC-20 balance state overrides on the trampoline

Rejected: detecting the balance slot of an arbitrary ERC-20 is fragile per-token probing with ongoing maintenance (different Solidity layouts, Solady, proxies).

### C. Trampoline code override at the user's address

Rejected: under floor-and-sweep semantics, "the instance" would be the user, so the sweep drags the user's pre-existing buy-token balance into the floor delta.

### D. `simulateExecute()` on the trampoline

Rejected: new audit surface on the contracts, a synthetic call shape instead of the real settlement.

### E. Keep eth_estimateGas

Rejected (COW-1297): `eth_estimateGas` does not return event logs, so there is no way to read `_delta` from the `Executed` event. Switching to `eth_simulateV1` is the minimum change needed to observe what the route actually delivered.

### F. SettlementNegativeSlippage check from the settlement's buy-token delta

Considered and dropped (COW-1297): once the clearing price is set to `min(simulationBuyAmount, quoteBuyAmount)`, the settlement can only receive exactly `simulationBuyAmount` buy tokens (what the route delivered). A `SettlementNegativeSlippage` check based on the settlement's delta would always pass when `simulationBuyAmount >= minBuyAmount` and always fail when `simulationBuyAmount < minBuyAmount` — which is already covered by the Trampoline's own floor check reverting the simulation. So the separate check is redundant.

## Consequences

- **`POST /proposals` carries no token addresses.** The orderbook is the source of truth.
- **The orderbook is a runtime dependency of validation.** If it is down, proposals defer (they are not rejected).
- **Proposals without simulation are invisible to `/solve`.** Correct — without chain connectivity, proposals cannot be meaningfully scored or settled.
- **`simulationBuyAmount` is stored per proposal.** Null for proposals validated before this feature or rejected before reaching simulation.
- **RPC load scales with active proposals.** Bounded per proposal by the ingestion lifetime cap ([ADR-0013](0013-proposal-lifecycle-and-retention.md)).
- **Hooked orders are supported** (COW-1243).
- **Anvil integration tests** are deferred to COW-1165.
