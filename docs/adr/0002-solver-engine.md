# Solver engine

Status: proposed; revised 2026-08-14 (minBuyAmount/quoteBuyAmount split)

Spec: docs/shared/design-document.md#solver-engine
      https://bleu.github.io/byos-docs/design-document#solver-engine

> Ported from [`bleu/cow-byos-architecture` ADR-0005](https://github.com/bleu/cow-byos-architecture/blob/main/docs/adr/0005-solver-engine.md). Still **proposed** — the open questions at the bottom are unresolved and several depend on CoW core team input. This is the ADR that `apps/byos` implements; treat the open questions as the first things to settle during M2.

## Context

The BYOS engine is the **solver engine** component of the CoW driver + solver architecture. The driver handles solution encoding, gas simulation, scoring (surplus + protocol fees in native token), and settlement submission. The solver engine's job is narrower: answer the driver's `/solve` request with candidate solutions sourced from its proposal cache.

This ADR settles how BYOS selects, validates, wraps, and returns proposals as solutions — encoding the decisions made in the contract ([contracts ADR-0001](https://github.com/bleu/byos-contracts/blob/main/docs/adr/0001-trampoline-topology.md)), escrow ([contracts ADR-0002](https://github.com/bleu/byos-contracts/blob/main/docs/adr/0002-escrow-contract.md)), slashing ([ADR-0003](0003-slash-attribution-flow.md)), and API ([ADR-0001](0001-proposal-api.md)) ADRs into engine behavior.

## Decision

The selection pipeline, scoring formula, settlement crafting, solution shape, and gas cut mechanics are specified in the design document (see Spec link above). This ADR records the rationale and the alternatives that were rejected.

### Why `surplus - gas` and no fee term

CoW's score is surplus plus protocol fees; gas reaches it only because the solver declares gas as its own fee, lowering surplus. The protocol fee cancels out of ranking. Once BYOS's cut equals the gas cost, `surplus - gas` is the score the autopilot will compute for the bid. The scoring formula uses `quoteBuyAmount` from the proposal to compute surplus and clearing prices.

BYOS does not estimate protocol fees either — the driver applies them itself, then encodes and simulates. A solution that cannot absorb the fee fails that simulation and is dropped with no revert, no penalty, and no escrow debit. Estimating it before `/solve` is also impossible: fee policies arrive only in the `/solve` payload.

**Fee-transform invariants (COW-1240).** The whole fee design rests on the assumption that the stock driver's protocol-fee application only moves the user/fee split and leaves everything else alone. This was established by reading the driver source in COW-1189 and verified against a real settlement with `FEE_POLICIES=surplus:0.5:0.01:any` in the offline demo stack (`offline-mode` branch `cow-1240`). Three invariants held:

1. The Trampoline `execute` interaction in the encoded `settle()` calldata is byte-identical to what BYOS sent — the driver does not touch the Trampoline call.
2. The sell amount pulled from the user is unchanged — the fee is not levied on the sell side.
3. The credited buy amount is reduced by exactly the computed protocol fee — the fee comes entirely from the buyer's surplus.

This confirms that BYOS can treat the Trampoline payload as immutable across the driver's fee application step.

### Why single best per order UID

Returning all valid proposals would flood the driver's encoding budget (each requires gas simulation via RPC). BYOS's internal pre-ranking ensures only competitive proposals consume encoding slots. With pick-one there is no fallback if the selected proposal fails the driver's post-encoding re-simulation, but the divergence between cached-gas score and the driver's fresh one is marginal.

### Why no batching across sub-solvers

Multi-sub-solver settlements would break the one-sub-solver-per-settlement-tx attribution rule ([ADR-0003](0003-slash-attribution-flow.md)). The driver's `SolutionMerging` is set to `Forbidden` to prevent the driver from blindly merging solutions from different sub-solvers.

### Why the gas cut is not padded

A bigger cut lowers the score, which lowers CIP-85 consistency rewards; those come from a shared bucket allocated by closeness to the winner, so BYOS does not recapture what it adds to the bucket. The cut recovers gas approximately — it is sized from the auction's native price, while the weekly payout converts at an average observed over roughly an hour around the trade.

### Validation split: ingestion vs `/solve`

Heavy validation runs in the **background validation loop**, not on the `POST /proposals` request — ingestion verifies the signature and stores the proposal as `submitted` (ADR-0001's async-ingestion revision, ADR-0013). Cheap validation runs at **`/solve` time** (local computation, no RPC): expiry, order liveness, amount matching, scoring + best-per-order selection.

EBBO baseline is **not** re-checked at `/solve` time — the ingestion-time check is the primary gatekeeping layer, and re-running it adds latency for marginal safety.

### `/solve` trust boundary: internal listener only

`/solve` response is the full standing proposal book for an auction — amounts, routes, and signatures, all MEV-relevant. Origin is enforced by network topology (separate internal listener, loopback by default) rather than path obscurity.

### `/solve` latency: non-issue by design

The path is: receive auction, indexed DB read (~1ms), pre-filter (microseconds), encode two interactions (sub-millisecond), solutions insert, return. No simulation and no RPC calls on the hot path.

## Open questions (not settled, flagged for discussion)

- **Batching across sub-solvers** (Q1 Option B) — **Out of scope**: requires reworking the attribution rule and merging strategy.
- **Thin Trampoline** (Q6 Option A) — **Resolved: fat Trampoline confirmed.** BYOS encodes two interactions (`sellToken.transfer` + one `execute` call).
- **Ingestion-time profitability gate** (Q7) — **Resolved by [ADR-0013](0013-proposal-lifecycle-and-retention.md):** proposals are rejected at the first simulation when the score is not positive.
- **Driver integration for outcome observation** (Q8) — **Resolved by [ADR-0010](0010-settlement-outcome-source.md):** the stock driver's `/notify` already delivers per-solution outcomes. No driver fork needed.

## Alternatives considered

- **Fully delegate scoring to the driver (no BYOS-internal ranking).** Rejected — floods the driver's encoding budget with obviously worse proposals.
- **Return all valid proposals (no pre-filter).** Rejected — the driver's encoding pipeline is the bottleneck.
- **Every-block continuous simulation.** Rejected — substantial RPC load with diminishing returns. The driver's post-encoding re-simulation catches staleness.
- **EBBO re-check at `/solve` time.** Rejected — requires a price lookup on the hot path.
- **Multi-order proposals in v1.** Rejected — the entire stack is designed for single-order proposals.
- **Fee over CoW rewards (not trade amounts).** Rejected — the RFP specifies a trade-level fee, and a reward-based fee cannot gate proposals at ingestion.
- **Revert-rate discounting (reliability oracle).** Rejected for v1 — premature optimization; escrow debits already penalize unreliable sub-solvers.
- **Enable driver `SolutionMerging`.** Rejected — would silently break the one-sub-solver-per-settlement-tx attribution rule.
- **Top-N per order UID.** Rejected — the RFP specifies "selects the one yielding the greatest surplus," and the marginal fallback benefit does not justify the encoding cost.
- **Clamp proposal amounts to remaining fill.** Rejected — changing amounts invalidates the sub-solver's computed route.

## Consequences

- **BYOS is a thin layer with internal scoring.** The engine's `/solve` scores the live proposal rows and encodes two Trampoline interactions.
- **Scoring divergence from the driver.** BYOS's `surplus - gas` uses cached gas estimates and reference prices, which may diverge from the driver's post-encoding results. Because BYOS sends a single proposal per order, there is no fallback if the selected proposal fails re-simulation.
- **No batching means lower theoretical maximum score.** Single-order solutions can't capture CoW surplus or batching efficiencies.
- **Outcome observation costs no extra infrastructure**, per [ADR-0010](0010-settlement-outcome-source.md).
- **The profitability gate may reject viable proposals.** A proposal rejected during a gas spike would have been profitable minutes later. `Rejected` is terminal (ADR-0013), so the sub-solver has to resubmit.
- **The gas cut recovers gas approximately, not exactly.** The gap is accepted and monitored.
- **Buffer debit after settlement.** After a successful settlement, the penalty job computes the gap between `quoteBuyAmount` and the delivered amount. It converts this gap to ETH with the auction reference price. The job debits the sub-solver's escrow for the ETH-equivalent gap.
- **Proposal freshness gap.** With 3–5 block simulation intervals, proposals can be up to ~60s stale. The driver's re-simulation catches this, but with pick-one there is no fallback.
