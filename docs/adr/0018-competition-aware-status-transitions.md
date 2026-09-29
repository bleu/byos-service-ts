# ADR-0018: Competition-Aware Status Transitions

**Status:** Accepted

## Context

Before this ADR, proposals could only reach terminal status through the BYOS validation pipeline (rejected, simFailed, expired) or settlement outcomes (settled, settleFailed). Two important competitive outcomes had no representation:

1. **Sub-solver outbid internally**: BYOS receives multiple proposals for the same order from different sub-solvers and picks the best one at `/solve` time. The losing sub-solvers received no signal that their proposal would never be settled — their proposals remained `active` indefinitely until expiry.

2. **Solver outbid externally**: The BYOS solution is sent to the CoW driver but another solver wins the on-chain auction. The subsequent `estimateGas` revert with reason `"GPv2: order filled"` indicated the order was already filled by an external solver, but this was reported as `simFailed` — confusing diagnostic noise that appeared to imply a bug rather than a competitive loss.

## Decision

### (i) SubsolverOutbid — `/solve` time rejection

When BYOS selects a winning proposal at `/solve` time and records it as a solution (`recordSolution`), all active or submitted proposals for the **same `orderUid`** from **different sub-solvers** are immediately marked `rejected: SubsolverOutbid`.

Proposals from the **same sub-solver** are deliberately left untouched. BYOS may legitimately fall back to a same-solver runner-up (e.g. when the best proposal's cut breaches the signed limit), so marking them rejected would be premature.

The rejection is **fire-and-forget**: a failure to write the rejection never blocks the `/solve` response. The edge case where the write fails and a sub-solver briefly sees its proposal as `active` is accepted.

Quote auctions (`id` is absent from the auction request) are excluded entirely — they are never settled, so outbid attribution is meaningless.

### (ii) SolverOutbid — simulation pipeline revert translation

When any step in the simulation pipeline reverts and `extractRevertReason` returns `"GPv2: order filled"` (trampoline resolution or gas estimation), the proposal is stored as `rejected: SolverOutbid` rather than `simFailed`. The translation happens in the storage layer (`resolveVerdict`), not in the blockchain validator: the validator passes the revert reason up in the `simFailed` verdict, and `resolveVerdict` decides the final status.

### (iii) settleFailed — unchanged

Settlement failures with other revert reasons remain `settleFailed`. These are genuine protocol-level failures rather than competitive losses and warrant separate operational attention.

## Consequences

- Sub-solvers polling their proposal status now receive a clear competitive signal rather than silence.
- The `RejectionReason` enum gains two new values: `SubsolverOutbid` and `SolverOutbid`.
- `simFailed` proposals will no longer carry `"GPv2: order filled"` as their stored reason — operators monitoring `simFailed` counts should see a reduction in false-positive noise.
- A sub-solver whose proposal is selected as runner-up (while a better same-solver proposal is in flight) will not be prematurely outbid. If that better proposal later fails, the runner-up remains eligible.
- The small window between `/solve` completing and `rejectOutbidProposals` committing means a losing proposal might briefly appear `active` to a racing poll request. This is accepted as an eventual-consistency trade-off.
- **Data note**: an earlier version of this feature (before `SolverOutbid` was introduced) stored raw contract revert strings directly into the `rejection_reason` column of `simFailed` proposals via an unsafe cast. Those rows have non-enum values in `rejection_reason` and will surface a `rejectionReason` field in API responses even though their `status` is `simFailed`. A one-off migration (`UPDATE proposals SET rejection_reason = NULL WHERE status = 'simFailed' AND rejection_reason IS NOT NULL`) clears the pollution; the same applies to `proposals_log`.
