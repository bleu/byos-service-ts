# Active-active replicas and durable debit operations

Status: accepted

Spec: docs/shared/design-document.md#penalties
      https://bleu.github.io/byos-docs/design-document#penalties

## Context

The service's proposal state and solution attribution already live in Postgres, and BullMQ distributes a scheduled job through its shared Redis queue. Multiple replicas therefore improve HTTP availability and worker failover without requiring a leader.

The remaining replica-local inputs were the latest auction gas price and penalty retry maps. The latter is unsafe: a process can crash after submitting an irreversible escrow debit and before recording its result, and a replacement worker can construct a second debit.

## Decision

Every replica may serve both HTTP listeners and start every BullMQ worker. There is no leader election or designated worker replica.

`/solve` persists the valid auction `effectiveGasPrice` and its timestamp in Postgres. Validation workers refresh that shared value once per tick; `DEFAULT_GAS_PRICE` remains the fallback before the first auction.

Every chargeable event has one Postgres debit operation, protected by a unique source key. A worker owns an operation only through an expiring database lease. The operation records its attempts, retry state, errors, signed raw transaction and hash. It is signed and persisted before first broadcast. A successor inspects or rebroadcasts precisely those bytes; it never signs a replacement debit. After ten failed attempts it is parked in `needs_reconciliation` until an operator explicitly resumes it.

## Consequences

- A worker crash can delay a debit, but cannot cause a second debit for its event.
- Buffer ledger batches are chargeable events and use the same operation protocol.
- Fleet-wide RPC concurrency and deployment consistency remain operational concerns, outside this decision.
