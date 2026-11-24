# Deadline-aware sub-solver auction processing

Status: accepted

Spec: docs/shared/guides/sub-solver-integration.md#the-post-response-is-the-verdict

## Context

BYOS validates proposals inline, so awaiting a POST includes escrow and settlement
simulation. Both reference adapters collected every quote before sending the first
proposal, then sent proposals sequentially. Their listener queued every auction
push behind the entire previous cycle. A slow vendor build could therefore delay
unrelated ready routes, and old cycles could submit after BYOS moved to a new auction.

## Decision

Keep scheduling shared between Binance and Fynd. Stream each completed order into
a bounded submission pool, so provider latency for one order does not hold every
other order behind a batch barrier. Bound POST concurrency independently from quote
concurrency because BYOS validation consumes a different resource: simulation RPC.

Prefer the newest auction over a FIFO history. Cancel superseded local work and
keep one pending push, rather than running all auction cycles concurrently. Carry
the auction identity, deadline, and cancellation signal through the adapters and
HTTP transports. Reserve time before the deadline for BYOS validation and selection;
recheck eligibility after signing and after waiting for a submission slot.

Use a routing-only Fynd transport built on the SDK's generated HTTP client because
the high-level quote method does not expose an AbortSignal. Validate its wire
response at this boundary and preserve the normal SDK for polling and metadata.

## Consequences

- Provider/build failures and simulation rejections remain independent per route.
- Per-order calldata ranking is bounded by the time available. Waiting indefinitely
  for a potentially shorter route would discard the useful completed alternatives.
- Cancelling local HTTP work does not retract a proposal BYOS already received.
  BYOS remains the authority for proposal status and the auction it validates against.
- Queue time, quote time, POST time, and submission failures are observable separately.
- Existing defaults remain usable; deployments can tune submission concurrency and
  the deadline reserve to their RPC capacity and observed validation latency.

## Alternatives considered

- **Unbounded concurrent cycles or POSTs:** spreads stale work and simulation load
  across newer auctions instead of bounding it.
- **FIFO auction history:** spends the current window processing expired opportunities.
- **One fixed timeout without a deadline:** a bounded call can still finish too late.
