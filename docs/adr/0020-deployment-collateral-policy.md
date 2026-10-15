# Deployment collateral policy and frozen penalty evidence

Status: accepted

Spec: docs/shared/design-document.md#collateral-gates-and-deployment-penalty-cap

Supersedes ADR-0003's fixed penalty sizing, buffer threshold, and immutable-v1
policy rationale. ADR-0013's replacement guarantee remains in force.

## Context

Fixed per-order collateral discourages small routes and ties entry requirements
to the maximum penalty. PR 103 introduces deployment-scoped proportional caps.
This is a deliberate policy migration, not an exact mirror of CoW's current
CIP-87 implementation; protocol formula alignment is deferred separately.

Submitted proposals lack validated price and gas inputs. Counting them during
admission creates a circular dependency that can reject otherwise valid routes.
A strict collateral reservation would require serializing admission across
replicas, adding coordination to the final validation step.

## Decision

Use a low flat floor followed by post-simulation exposure admission. Keep
expensive work concurrent and exclude submitted siblings. Admission is best
effort: concurrent checks can overcommit collateral, and BYOS accepts the
resulting shortfall risk. Preserve replacement eligibility and reserve executing
routes, because an executing route may still incur a charge.

Buffer credits compensate delivery shortfalls, not gas or revert penalties;
treating credits as escrow would create unrecoverable collateral.

Freeze the applicable cap with synchronous auction attribution. Keep validation
prices separate from auction evidence and retain unresolved penalty references
through sweeping. This makes the charge reproducible after price movement,
revalidation, restart, or retention. Pre-snapshot events use the absolute-cap
fallback; do not reconstruct historical prices from mutable rows.

The buffer clearing threshold remains deployment-scoped, independently of any
individual order's proportional cap. Batching recovers the full net debt while
avoiding small on-chain debits.

Roll out as an announced service/database policy migration. Deployment
parameters must be disclosed before accepting new proposals. The migration adds
snapshot columns, backfills validation prices, and preserves existing charges;
it changes no contract interface or signing domain. Future parameter changes
must use the same migration discipline.

## Alternatives considered

- Serialize collateral admission per sub-solver: stronger guarantees, declined
  in favor of concurrent validation and the accepted overcommitment risk.
- Defer every proposal with an unpriced submitted sibling: preserves a circular
  wait because neither sibling can reach acceptance and persist its price.
- Recompute penalties from current prices: rejected because an event's liability
  must survive later validation and auction changes.

## Consequences

The specification owns formulas, boundaries, defaults, and legacy fallback
behavior. ADR-0005's pure-domain eligibility rule applies to the shared math;
ADR-0006 continues to own environment validation and defaults. No new RPC or
simulation enters the /solve path.
