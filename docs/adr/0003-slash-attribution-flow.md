# Slashing policy & attribution flow

Status: accepted; revised 2026-08-14 (buffer debit for minBuyAmount/quoteBuyAmount)

Spec: docs/shared/design-document.md#penalties
      https://bleu.github.io/byos-docs/design-document#penalties

> Ported from [`bleu/cow-byos-architecture` ADR-0003](https://github.com/bleu/cow-byos-architecture/blob/main/docs/adr/0003-slash-attribution-flow.md). This is the canonical, service-side version of the policy; [`bleu/byos-contracts` ADR-0004](https://github.com/bleu/byos-contracts/blob/main/docs/adr/0004-penalty-schedule-and-attribution.md) is a contract-scoped extract of the same decision. The escrow mechanics referenced here (debit, freeze, events) are implemented as an ERC20 ledger per [contracts ADR-0007](https://github.com/bleu/byos-contracts/blob/main/docs/adr/0007-erc20-escrow-token.md); use `effectiveBalance()` for eligibility checks.

## Context

When CoW imposes a cost on BYOS, BYOS must attribute it to the responsible sub-solver and recover it from escrow ([contracts ADR-0002](https://github.com/bleu/byos-contracts/blob/main/docs/adr/0002-escrow-contract.md)) — without being able to fabricate a slash against an honest sub-solver. Two coupled sub-decisions from the [economics design note](https://github.com/bleu/cow-byos-architecture/blob/main/docs/design/byos-subsolver-economics.md):

- **Q3** — Track-B arbiter: who adjudicates EBBO/fairness passthrough claims?
- **Q4** — Attribution: how does BYOS map a settlement to the responsible sub-solver?

CoW's own penalty framework has four enforcement layers (see [`../shared/reference/cow-solver-slashing-policy.md`](../shared/reference/cow-solver-slashing-policy.md)). The penalty schedule, Track A/B flows, attribution model, and `c_l` values are specified in the design document (see Spec link above). This ADR records the rationale for those choices.

## Decision

### Why one sub-solver per settlement tx (attribution)

The per-sub-solver Trampoline CREATE2 address ([contracts ADR-0001](https://github.com/bleu/byos-contracts/blob/main/docs/adr/0001-trampoline-topology.md)) in the settlement calldata self-evidences which sub-solver's route ran — no reliance on BYOS's private records. This makes Track A debits indisputable and Track B attribution clean. Cost: less batching efficiency. Accepted — clean attribution is worth more than marginal gas savings.

### Why BYOS-unilateral for Track A

Track A parameters are on-chain-verifiable (tx receipt, gas cost, Trampoline CREATE2 address). A provably incorrect debit is an operational bug, not a policy failure.

### Why CoW core team for Track B

They already adjudicate EBBO; routing Track B to them ensures BYOS cannot fabricate a certificate. Sub-solvers receive the same evidence standard, challenge window, and appeal rights that CoW gives BYOS.

### Why gatekeeping is non-exculpatory

Passing gatekeeping does not absolve the sub-solver of liability if CoW later determines the settlement violated protocol rules. Gatekeeping reduces risk; it does not eliminate it.

### Hooks and sub-solver responsibility

Hooks are handled by BYOS and the driver, not by sub-solvers (COW-1243). The orderbook pre-encodes hooks as `HooksTrampoline.execute()` calls; BYOS includes them in simulation for accurate gas estimates, and the driver appends them to the settlement. Sub-solvers submit routing proposals without hook interactions. Some hooks change token balances available for the route; sub-solvers must account for their effects when computing routes, but do not encode or submit them.

### Why a buffer debit for aggressive buy-amount ranges

A sell-order proposal can set `minBuyAmount` below `quoteBuyAmount`. The engine uses `quoteBuyAmount` to compute surplus and clearing prices. The on-chain floor is `minBuyAmount`. After settlement, the penalty job reads the delivered amount from the `Executed` event and records a signed ledger entry: positive when the sub-solver under-delivered, negative when it over-delivered. Credits offset debits naturally.

The penalty job slashes the sub-solver's escrow only when the outstanding balance exceeds `c_L`. It debits the full accumulated balance in one transaction and marks all entries as cleared. This batching reduces on-chain costs and lets small shortfalls net out against over-deliveries before any charge lands.

Buy orders must set `minBuyAmount` equal to `quoteBuyAmount`. The engine rejects buy-order proposals where the two values differ.

### Why payouts for over-delivery are manual

When a sub-solver consistently over-delivers (`delivered > quoteBuyAmount`), the buffer ledger accumulates negative entries (BYOS owes the sub-solver). The service records these credits but does not pay them out automatically. The BYOS operator reviews negative balances and deposits collateral to the sub-solver's escrow manually. Automated payouts are deferred: they require a withdrawal mechanism on the escrow contract and policy decisions about payout frequency, minimum thresholds, and fraud checks that are outside the scope of v1.

### Non-settlement detection

A driver `Cancelled`/`Expired`/`Fail` notification for an `Executing` proposal is the trigger — the driver confirmed it began submitting ([ADR-0010](0010-settlement-outcome-source.md)) and then abandoned the settlement with no tx landing. The executing-*timeout* release ([ADR-0013](0013-proposal-lifecycle-and-retention.md)) is **not** charged: a lost notification is not proof of non-settlement.

### Minimum escrow balance

Sized to cover worst-case Track A: `gas + c_l` for a single settlement. This keeps the barrier to entry low for a permissionless system. Track B is inherently under-collateralized; gatekeeping is the primary Track B defense, not escrow sizing.

### Policy lifecycle

Immutable for v1. No unilateral updates. Changes require a v2 policy with a new escrow deployment or migration.

## Alternatives considered

- **Replicate all four CoW enforcement layers.** Rejected — Layers 1 and 2 are either architecturally prevented or already covered by gatekeeping + escrow + collateral gate.
- **Pass all Layer 3 violations through to sub-solvers.** Rejected — sub-solvers cannot cause most of these violations. BYOS controls score construction, buffer access, and settlement composition.
- **Sub-solvers encode hooks in their proposals.** Reversed (COW-1243) — BYOS now handles hooks.
- **No penalty for non-settlement.** Rejected — non-settlement degrades BYOS's participation-guard standing with CoW.
- **Credit Track A against Track B for the same settlement.** Rejected — the sub-solver's proposal caused both problems.
- **Formal dispute mechanism for Track A with external arbiter.** Rejected — Track A is on-chain-verifiable. BYOS-unilateral adjudication is sufficient.
- **Public slashing dashboard / reporting.** Rejected — leaks competitive intelligence about sub-solver routing quality.
- **Permanent ban or debt tracking on escrow shortfall.** Rejected — meaningless in a permissionless system. The escrow loss itself is the penalty.
- **Higher minimum escrow.** Rejected — Track B is inherently under-collateralized regardless of minimum size. Low barriers to entry matter.
- **Versioned or updatable policy.** Rejected for v1 — adds complexity.

## Consequences

- **Sub-solvers trust BYOS for Track A adjudication.** BYOS is both debitor and dispute judge. Mitigation: Track A parameters are on-chain-verifiable.
- **Track B has an unrecoverable gap.** If the sub-solver withdrew or escrow < claim, BYOS absorbs the shortfall. This is why gatekeeping is mandatory.
- **Non-settlement penalty relies on BYOS's internal records.** Accepted trust assumption, consistent with the operator trust model.
- **One sub-solver per settlement tx reduces batching efficiency.** Accepted — clean attribution enables indisputable debits.
- **Immutable v1 policy means no ability to adjust parameters.** Mitigated by conservative initial sizing and the expectation that v1 is a learning phase.
- **36h sub-solver challenge window for Track B is tight.** Accepted — BYOS needs the remaining 36h of its 72h CoW window.
- **The service tracks a 5x off-chain reserve against pending Track-B claims** ([contracts ADR-0002](https://github.com/bleu/byos-contracts/blob/main/docs/adr/0002-escrow-contract.md)): reserve calculation and proposal-eligibility math are a BYOS-service responsibility and a critical path.
