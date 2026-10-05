# Slippage Protection

Status: accepted

Spec: docs/shared/design-document.md#simulation
      https://bleu.github.io/byos-docs/design-document#simulation

## Context

A sub-solver can set `minBuyAmount` much lower than `quoteBuyAmount`. The Trampoline enforces only the floor (`minBuyAmount`) on-chain — it does not enforce the ceiling. A route that only delivers `minBuyAmount` tokens passes the floor check and settles successfully, but BYOS then uses `quoteBuyAmount` as the clearing price, which overstates the buy tokens the settlement received. This causes negative slippage: the settlement pays the user more buy tokens than the route delivered, and the difference comes out of BYOS's own buffer. The sub-solver takes a penalty later, but the buffer loss is immediate.

Depends on: [ADR-0001](0001-proposal-api.md) (proposal fields), [ADR-0012](0012-simulation.md) (simulation pipeline).

## Decision

Two complementary controls address the problem:

### 1. simulationBuyAmount: clearing price from simulation (primary)

`simulationBuyAmount` is the `Executed._delta` value from the simulation (see [ADR-0012](0012-simulation.md)). At `/solve` time the effective clearing price is `min(simulationBuyAmount, quoteBuyAmount)`, not `quoteBuyAmount` directly. If the simulation showed the route delivers less than `quoteBuyAmount`, the clearing price is corrected downward before the bid is sent to the driver.

This is the primary defense: if the route under-delivers at simulation time, the settlement is never sent with an inflated clearing price.

### 2. Pre-simulation gap check (secondary)

Before dispatching simulation, a cheap gap check rejects proposals where the `minBuyAmount`/`quoteBuyAmount` spread is unreasonably large. This limits the damage a sub-solver can inflict per proposal even if `simulationBuyAmount` is unavailable (pre-feature or deferred proposals).

The check applies to **sell orders only** — buy orders already hard-enforce `minBuyAmount == quoteBuyAmount` in the envelope check.

A proposal is rejected with `ProposedSlippageOutrange` if EITHER cap is exceeded:

```
gap = quoteBuyAmount − minBuyAmount

bps cap:    gap × 10_000 > quoteBuyAmount × MAX_PROPOSAL_SLIPPAGE_BPS
native cap: gap × nativePrice > MAX_PROPOSAL_SLIPPAGE_NATIVE × 10^18
```

`nativePrice` is the buy token's price in native-token units (from the CoW orderbook), fetched in parallel with the order at the start of validation. If the price is unavailable for a sell order, the proposal is rejected (fail closed).

### Configuration

Two new environment variables (see `apps/byos/src/config.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `MAX_PROPOSAL_SLIPPAGE_BPS` | `100` | Maximum gap as basis points of `quoteBuyAmount` |
| `MAX_PROPOSAL_SLIPPAGE_NATIVE` | `1000000000000000000` (1 ETH) | Maximum gap in native-token wei |

The dual cap protects against both small-token attacks (large bps, tiny native impact) and large-token attacks (small bps, large native impact). Either cap triggers rejection.

### Rejection reasons

Two new `RejectionReason` values in `@byos/common`:

- `ProposedSlippageOutrange` — gap check failed.
- `SimulationMissingExecutedEvent` — simulation succeeded but the Trampoline `Executed` event was not found in the logs. This is a simulation failure (terminal, not retried), not a slippage error.

## Alternatives considered

### A. SettlementNegativeSlippage: check the settlement's buy-token delta during simulation

This was the original design motivation: detect negative slippage directly by comparing the settlement's buy-token balance before and after simulation. Dropped in favor of `simulationBuyAmount`: once the clearing price is set to `min(simulationBuyAmount, quoteBuyAmount)`, negative slippage at the settlement level is already prevented — there is no residual to check. A separate settlement delta check would be redundant.

### B. Reject any gap between minBuyAmount and quoteBuyAmount

The envelope already requires `order.buyAmount <= minBuyAmount`. A gap between min and quote is how the sub-solver opts into loose slippage — a legitimate feature. A zero tolerance would break the loose-slippage mechanism entirely.

### C. Only one cap (bps or native)

A single bps cap is blind to absolute value: 100 bps on a 1 WBTC proposal is a much larger absolute risk than 100 bps on a 10 USDC proposal. A single native cap is blind to relative value: a small nominal gap on a dust token might exceed the cap spuriously. Both caps together reject proposals only when they are large both relatively and absolutely — the correct failure mode.

### D. Enforce cap on-chain in the Trampoline

Rejected: the on-chain protocol already handles the case via the floor check. The gap cap is an off-service business rule that changes without a contract upgrade.

## Consequences

- **New env vars required.** `MAX_PROPOSAL_SLIPPAGE_BPS` and `MAX_PROPOSAL_SLIPPAGE_NATIVE` must be set or the defaults apply. Operators should tune them to their risk tolerance.
- **Sub-solvers with loose slippage beyond the cap are rejected.** The default 100 bps / 1 ETH cap is conservative; operators with higher-risk tolerance can raise it.
- **Buy-token price is always fetched at validation time.** For sell orders, a missing price is a hard rejection (fail closed). This is a new orderbook dependency relative to the pre-COW-1297 validator.
- **`simulationBuyAmount` is a new nullable column.** Null for proposals validated before this feature; the effective buy amount falls back to `quoteBuyAmount` in that case.
