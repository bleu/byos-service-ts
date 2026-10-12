# Same-sub-solver settlement batches

Status: accepted, 2026-10-09

Spec: docs/shared/design-document.md#single-order-solutions

## Decision

Permit same-sub-solver batching after best-per-order selection. This supersedes ADR-0002's single-order solution restriction and preserves ADR-0003's one-sub-solver-per-settlement attribution rule.

The driver chooses a winning solution; returning each order as an alternative leaves burst settlement throughput dependent on repeated auctions. Packaging compatible winners together lets that winning solution settle multiple orders. Exact proportional clearing prices preserve each member's exchange ratio; incompatible prices remain separate candidates.

Keep driver merging disabled: it cannot enforce our external sub-solver boundary. Keep proposal signatures unchanged: batching combines independent signed proposals, rather than introducing a batch proposal.

Record all batch members before bidding. Attribute outcomes to every member while charging transaction failures once. Keep successful delivery accounting per order because the Trampoline emits a separate Executed event for each route.

## Consequences

A failing route can prevent its entire batch from settling. Gas estimates remain conservative sums of per-order estimates. This change does not add netting, cross-sub-solver attribution, or a batch size optimizer.
