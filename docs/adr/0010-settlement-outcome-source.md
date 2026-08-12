# Settlement outcome source & Track A trigger

Status: accepted

Spec: docs/shared/design-document.md#proposal-lifecycle
      https://bleu.github.io/byos-docs/design-document#proposal-lifecycle

> Resolves the "driver callbacks for outcome observation" open question from [ADR-0002](0002-solver-engine.md). Uses the slashing policy in [ADR-0003](0003-slash-attribution-flow.md). Rewritten 2026-07 during the proposal-lifecycle review ([ADR-0013](0013-proposal-lifecycle-and-retention.md)): the original version proposed forking the driver to add an outcome hook; the stock driver turned out to already send everything we need.

## Context

When a BYOS settlement fails, we charge the responsible sub-solver (Track A, [ADR-0003](0003-slash-attribution-flow.md)). To do that we need three things: to know it failed, the gas it cost, and which sub-solver to charge.

The first plan was a chain watcher: scan every block, find our settlement, check if it reverted. The second plan was a driver fork with a custom outcome hook. Then we checked what the standard driver-solver-engine protocol already carries: `POST /notify` delivers `SettlementStarted`, `Success`, `Revert`, `Cancelled`, `Expired`, `Fail`, and pre-submission rejections, per solution with auction and solution ids. The notification-to-state mapping is specified in the design document (see Spec link above).

## Decision

Get the outcome from the stock driver's `/notify` notifications. No fork, no chain watcher.

- **Trigger.** `Revert { transaction }` is the Track A trigger; `Success` closes the proposal as settled.
- **Attribution.** `/solve` records `(auction_id, solution_id, proposal_id)` in the `solutions` table before returning a solution (ADR-0013), so attribution is a join in our own database. The Trampoline address in the settlement calldata remains the on-chain proof.
- **Gas.** BYOS makes one `eth_getTransactionReceipt` call on the reverted tx hash to read the real gas used and gas price. The receipt read is required, not a double-check: it is how we get the amount to debit.
- **Escrow stays native.** Track B is triggered by hand, not by a chain event.

## Alternatives considered

- **Driver fork with a custom outcome hook** (this ADR's original decision). Obsolete: the stock `/notify` protocol already delivers the outcome per solution. The fork idea is dropped entirely (COW-1190 canceled).
- **Chain watcher (scan blocks).** Rejected. Rebuilds what the driver does, misses private and dropped txs, and cannot spot a missed deadline without knowing what we sent.
- **Autopilot observations.** Rejected. CoW-run, tied to its database, wrong attribution level (solver, not sub-solver), gas table dropped (migration `V090`).
- **Shepherd (WASM) module.** Rejected here. Shepherd earns its place when you subscribe to chain events; we have a push plus one read.
- **Driver applies the penalty.** Rejected. Keys and the debit decision stay in our audited escrow code, and the driver cannot do Track B.

## Consequences

- No chain indexer to build or run, and no driver fork at all.
- BYOS must expose `/notify` and keep the `solutions` mapping durable ([ADR-0013](0013-proposal-lifecycle-and-retention.md)).
- Missed-deadline detection is free, from the driver's `Expired`/`Cancelled` notifications.
- Private submissions are covered, because the driver is the source.
- Lost notifications are survivable for liveness: ADR-0013's executing-timeout returns the proposal to `Active`, and re-simulation reconciles reality. A lost `Revert` does cost the Track A debit for that settlement unless recovered by hand.
- We are not using Shepherd for this.
