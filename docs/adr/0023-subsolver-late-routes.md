# Sub-solver cycles keep routes that outlive their auction

Status: accepted

Spec: docs/shared/guides/sub-solver-integration.md#the-post-response-is-the-verdict

## Context

ADR-0022 aborted Binance and Fynd quotes and proposal POSTs at the auction
deadline, and cancelled a running cycle when a newer auction arrived. It assumed
a route that missed its auction's deadline was worthless.

BYOS does not bind a proposal to the auction its sub-solver quoted for. A POST is
validated against whichever auction is open when it arrives, and the candidate
joins that auction's competition. A route that takes longer than one auction
therefore still bids in the next one. Most Binance routes need two vendor round
trips (quote, then build), which regularly exceeded the roughly 550 ms that the
deadline reserve left on short auctions. After ADR-0022 shipped, those routes were
discarded instead of bidding one auction later, and the BYOS bid rate dropped.

## Decision

Acknowledge each `/solve` push immediately and run its cycle in the background.
Cycles run concurrently, with no deadline cutoff and no cancellation when a newer
auction arrives.

Keep two parts of ADR-0022:

- Stream each order's routes to BYOS as soon as that order is quoted, so a slow
  order does not delay routes that are already ready.
- Keep quote concurrency bounded per cycle.

Each sub-solver tracks the orders an overlapping cycle is still quoting or
submitting, and skips them. Overlapping cycles therefore pick up only new orders
and do not spend vendor quota or the BYOS request budget on duplicates. They also
share one in-progress proposal-state read. A fixed per-request timeout on the
Binance client bounds a hung request, so its order is released for a later cycle.

## Consequences

- Late routes become bids in the next auction instead of being dropped.
- The number of concurrent cycles is bounded by the orders not already in flight,
  not by the auction rate.
- Fynd quotes rely on the SDK's own request behaviour; a hung Fynd request holds
  only its own order.
- `SUBSOLVER_DEADLINE_BUFFER_MS` and `BYOS_SUBMISSION_CONCURRENCY` are removed.
  Deployments that still set them are unaffected because unknown variables are
  ignored.
