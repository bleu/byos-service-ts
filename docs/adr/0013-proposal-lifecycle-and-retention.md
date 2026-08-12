# Proposal lifecycle & retention

Status: accepted

Spec: docs/shared/design-document.md#proposal-lifecycle
      https://bleu.github.io/byos-docs/design-document#proposal-lifecycle

## Context

The proposal state machine grew by accretion: `Submitted -> Active` plus five terminal states, defined in `domain/proposal.rs` and described piecemeal across ADR-0001 (ingestion, persistence), ADR-0012 (simulation, re-validation), and ADR-0010 (settlement outcomes). Several things were missing or wrong as of 2026-07:

- **Nothing ever set `Settled`.** The state existed in the enum and the audit mapping, but no code path reached it — ADR-0010's outcome source was still a proposed driver fork.
- **Nothing happened between winning and the outcome.** A proposal picked by `/solve` stayed `Active`: it kept being re-simulated and kept being offered to the next auction while a settlement built on it was in flight.
- **Terminal proposals never left memory** (COW-1177).
- **`validUntil` was unbounded.**
- **Retention was deliberately deferred.**
- **The ingestion-time profitability gate** (ADR-0002 Q7) had no write-up and no defined place in the lifecycle.

One discovery reshaped the settlement half: the stock CoW driver already notifies its solver engine per solution (`/notify`). No driver fork is needed — ADR-0010 is rewritten accordingly.

## Decision

The state machine, transition table, notification-to-state mapping, retention policy, and storage model are specified in the design document (see Spec link above). This ADR records the rationale for those choices.

### Why `Executing` is entered on `SettlementStarted`, not at `/solve` time

At `/solve` time we don't yet know we won. The window between the autopilot picking our solution and `SettlementStarted` arriving is accepted: it is sub-second-to-seconds, and inventing a "won but not yet submitting" state isn't worth it.

### Why `Executing -> Active` is always safe

If the order was actually consumed (our tx landed but the notification was lost, or the order was filled externally), the next re-simulation reverts and the proposal dies as `SimFailed`. Re-simulation is the truth-teller. The executing timeout (default 5 minutes) covers lost notifications and restarts mid-settlement.

### Why simulation stops at the first revert

A once-reverted proposal offered to `/solve` risks an on-chain revert and a penalty for the sub-solver, which is strictly worse than resubmitting. Transient transport errors still defer rather than fail. Resubmission is the sub-solver's "I still believe in this route" signal.

### Why the profitability gate runs on first simulation only, not re-validation

Gas prices wobble; rejecting an `Active` proposal on a spike would churn proposals that are profitable again two blocks later. `/solve` re-scores with fresh gas at auction time, so an unprofitable-right-now proposal cannot leak into a solution.

### Why proposal lifetime is capped at ingestion

`validUntil` more than `--max-proposal-lifetime` (default 5 minutes) in the future is rejected. This bounds worst-case simulation cost per proposal and turns the "short proposal lifetimes" assumption into an enforced invariant.

### Why losing is not a state

A proposal that loses an auction is still a valid, executable proposal for the next auction. Participation is recorded as data (the `solutions` table plus audit events), not as a status. Winning *is* a state change because it changes what the service does.

### Why Postgres, not in-memory or Redis

A restart no longer erases what a sub-solver needs to see about why its proposal died. Live proposals survive. An indexed read over a few hundred live rows is ~1 ms against a seconds-scale deadline. A second store is premature until `/solve` latency data says otherwise.

### The compare-and-swap transition

`UPDATE proposals SET status = $to WHERE id = $id AND status = $from` — zero rows affected means the caller's verdict was stale (a cancellation or notification won the race), exactly the in-memory semantics, now durable.

### The `solutions` table

Maps notifications back to proposals: `(auction_id, solution_id, proposal_id, created_at)`, written synchronously inside `/solve` before the solution is returned — if we can't record it, we don't bid it.

### The write-behind crash window

An audit event is emitted only after its proposal write commits, so a crash between the two leaves a durable state change with no matching event. Closing it would couple every store write to the audit codec and remove the writer's retry isolation. Accepted: one event per crash.

### Retention

- **Rejected, SimFailed, Expired, Cancelled**: deleted 1 hour after reaching the state.
- **Settled, SettleFailed, Penalized**: kept indefinitely, no sweep code.
- **`audit_events`**: no deletion path.

## Alternatives considered

- **"Lost auction" as a proposal state.** Rejected — the proposal would bounce `Active -> Lost -> Active` every auction while remaining fully valid.
- **Enter `Executing` at `/solve` time.** Rejected — we don't know we won; every non-winning round would need an unwind path.
- **N-strikes or never-terminal `SimFailed`.** Rejected — a once-reverted proposal at `/solve` risks a penalty; never-terminal burns an RPC call per tick on dead orders.
- **Re-applying the profitability gate on re-validation.** Rejected — gas-price flapping churns proposals that `/solve`'s own auction-time filter already handles.
- **In-memory terminal retention with a TTL.** Rejected — a restart erases what a sub-solver needs to see about why its proposal died.
- **Redis (or any second store) for live proposals.** Rejected as premature — one database is enough at this volume.
- **Penalty as audit events only, no `Penalized` state.** Rejected — the debit tx hash belongs on the proposal so "was this charged" is a row lookup.
- **Per-tier deletion windows for the money states.** Rejected for now — indefinite retention of a small set costs nothing.

## Consequences

- **BYOS gains a `/notify` endpoint** on the internal listener, and `/solve` gains a synchronous `solutions` insert.
- **ADR-0010 is rewritten**: the outcome source is the stock driver's notifications, not a driver fork.
- **Breaking API changes for sub-solvers**: `validUntil` more than a few minutes out is rejected; dropped proposals 404 an hour after dying; the status vocabulary grows.
- **COW-1177 (terminal-proposal pruning) is resolved** by the retention sweep.
- **`POST` gets one DB write on the request path** (and `DELETE`/`GET` their reads). The async-ingestion rule still holds.
- **Simulation load is bounded**: worst case one `eth_estimateGas` per proposal per tick for at most `--max-proposal-lifetime`.
- New configuration: `--max-proposal-lifetime` (default 5m), `--executing-timeout` (default 5m), `--dropped-retention` (default 1h).
