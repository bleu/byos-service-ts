# Evidence-backed non-settlement penalties

Status: accepted

Spec: docs/shared/design-document.md#penalties
      https://bleu.github.io/byos-docs/design-document#penalties

## Context

The lifecycle refactor made `lost` include competitive losses and unknown
outcomes. Using that status as a financial queue charged ordinary auction losses
and timeouts. This contradicted ADR-0003: absence of an outcome is not proof of
abandonment after submission began.

## Decision

Keep financial evidence and debit eligibility independent of proposal status.
The proposal log remains the durable bid attribution record. A separate settlement
attempt references the auction and canonical set of returned solution IDs, and
retains deduplicated driver notifications. A solution belongs to at most one
attempt, preventing single and merged notifications from creating multiple charges.

Why require both start and abandonment evidence: it restores ADR-0003's existing
liability boundary without reintroducing `executing` into the proposal lifecycle.
Arrival order is not event order; retain both notifications even after timeout
reconciliation has removed the live proposal. Drivers without a start notification
cannot authorize automated non-settlement charges.

Why snapshot policy inputs at bidding: auction-time reference prices determine
the applicable proportional cap. Store it with the submitted proposal. The attempt
freezes the cap, amount, and policy version when first observed. Missing inputs
require reconciliation rather than a larger global fallback.

Why use an attempt-scoped debit identity: a proposal UID can legitimately recur,
and neither a UID nor `lost` uniquely identifies a chargeable settlement. The
existing durable debit protocol still owns signing, retries, leases and recovery.
Financial eligibility and notification evidence commit together. A row lock on the
attempt serializes corrections with the financial worker's final eligibility check
and chain calls. Signed bytes commit independently before broadcast; finalizing
attempt, proposal penalty hash and debit operation is one transaction. This keeps
restart recovery safe even if finalization rolls back. The worker needs a second
pool connection for the independent durable writes; production uses a 50-connection
pool. The lock never spans a `/solve` request.

Why quarantine conflicting outcomes: a success or revert cancels an unsigned
abandonment charge. Once transaction bytes have been signed, their broadcast state
may be ambiguous after a crash. Retain those bytes and flag the attempt for manual
reconciliation, including compensation review if the debit landed. Do not silently
replace transactions or automatically credit escrow. A revert debit is also blocked
while the same attempt needs reconciliation, preventing a second charge for an
ambiguous abandonment transaction.

Solution merging remains forbidden by the service. Unexpected merged or overlapping
notifications require reconciliation; they never authorize separate member charges.
Supporting automatic penalties for merged settlements needs a defined aggregate cap
policy first.

## Consequences

- Outcome reconciliation remains observational and cannot create liability.
- Existing proposal statuses and public response fields stay unchanged.
- Migration 0016 does not backfill liabilities from historical losses. It parks
  unfinished legacy non-settlement operations, preserving signed bytes and evidence.
- Legacy charges already recorded, or signed legacy debits for the same sub-solver
  and UID, prevent fresh automatic authorization until reviewed.
- Deployment must stop old writers/workers before migration; old binaries still
  infer eligibility from `lost` and are incompatible with the corrected policy.
- Reconciliation queries and rollout instructions live in
  `docs/operations/non-settlement-penalties.md`.
