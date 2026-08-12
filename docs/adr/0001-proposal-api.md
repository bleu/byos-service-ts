# Proposal API & sub-solver authorization

Status: accepted

Spec: docs/shared/design-document.md#proposal-api
      https://bleu.github.io/byos-docs/design-document#proposal-api

> Ported from [`bleu/cow-byos-architecture` ADR-0004](https://github.com/bleu/cow-byos-architecture/blob/main/docs/adr/0004-proposal-api.md), where it was accepted during the grant proposal. The original ADR also settled the contract-side halves of this decision — the signature-gated `execute`, the EIP-712 `ProposalData` schema, and the factory-anchored domain. Those are owned and documented by [`bleu/byos-contracts` ADR-0005](https://github.com/bleu/byos-contracts/blob/main/docs/adr/0005-trampoline-execution-authority.md) and are only referenced here, not restated. This ADR keeps the service-owned decisions: the HTTP API surface, validation pipeline, rate limiting, process topology, and persistence.
>
> Revised 2026-07 during the COW-1159 review (COW-1173): ingestion validation switched from synchronous to asynchronous. The request path now does signature checking only; escrow and simulation run in a background validator. The original synchronous design is preserved under Alternatives.

## Context

The public HTTP API by which sub-solvers submit signed proposals. Endpoints (RFP):
- `POST /proposals` — `{order_uid, sell_amount, buy_amount, interactions, valid_until, nonce, signature}`; token addresses come from the orderbook order, not the sub-solver ([ADR-0012](0012-simulation.md))
- `GET /proposals/{order_uid}` — metadata only, never full contents (no leakage channel)
- `DELETE /proposals/{id}` — cancellation by the original signer

## Decision

The API surface, authentication model, rate limiting, process topology, and persistence are specified in the design document (see Spec link above). This ADR records the rationale for those choices and the alternatives that were rejected.

### Authentication: EIP-712 signature, signer is the identity

The recovered signer address IS the sub-solver's identity: it is the escrow key for collateral checks and the CREATE2 salt for its Trampoline instance. There is no separate `escrow_account` field and no delegation in v1 — a sub-solver who wants multiple strategies deposits separately per address.

Signing structs and domain parameters are consumed from the contracts repo, never redefined here. No off-chain nonce bookkeeping — the nonce is a unique salt for signature uniqueness, mirroring the storage-free contract design.

### Proposal payload shape: raw interactions

`Vec<{target, value, calldata}>` — the sub-solver encodes arbitrary calls against any DEX or protocol; the service passes them through for execution as-is inside the sub-solver's Trampoline.

Restricting to BYOS-known venues (structured routes) would defeat the permissionless any-DEX value proposition. Containment of arbitrary calls is the Trampoline's job, structurally ([contracts ADR-0001](https://github.com/bleu/byos-contracts/blob/main/docs/adr/0001-trampoline-topology.md)); the service's role is accept-or-reject at gatekeeping, never patching. The sub-solver is fully responsible for the complete route, including required hooks and approvals.

### Cancellation: EIP-712 signed, by server-assigned ID

`DELETE /proposals/{id}` requires an EIP-712 signed cancellation message. `CancelProposal` is purely an API-authentication type — it is never verified on-chain, so it is owned by this repo. Follows the CoW pattern (CoW uses `OrderCancellation { orderUid }` for order cancellations).

### GET metadata

Owned by [ADR-0011](0011-owner-scoped-reads.md): reads are signature-gated and owner-scoped.

### Proposal lifecycle

Owned by [ADR-0013](0013-proposal-lifecycle-and-retention.md): the state machine, transition rules (compare-and-swap status writes), rejection semantics, and retention.

What this ADR keeps: proposals are immutable. Amounts, interactions, `validUntil`, nonce, and signature form one signed unit, so there is no update operation on an existing proposal. Replacement is a new `POST` (optionally preceded by a `DELETE` of the old one) — which is why the API has no `PUT`.

### Ingestion validation: async, signature-only request path

`POST /proposals` does three things inline: parse the request, recover the signer (`ecrecover`), and check the expiry window. On success it stores the proposal as `Submitted` and answers `202 Accepted` with the proposal `id` — meaning "accepted for validation," not "accepted." All on-chain work runs in a background validator loop, off the request path.

### API topology: two listeners, one process

Separate listeners prevent public traffic from starving `/solve` of resources. Both run in one process against the same proposal store. Network-level isolation is straightforward (firewall the internal port).

### Persistence: Postgres store + async write-behind audit trail

The proposal store is owned by [ADR-0013](0013-proposal-lifecycle-and-retention.md), along with its retention policy. The audit trail — proposal lifecycle events asynchronously persisted as an append-only `audit_events` log for dispute evidence — is this ADR's scope. Track B claims arrive up to 3 months later, so the audit log must retain proposals for at least that window. There is no deletion path.

## Alternatives considered

Contract-side alternatives (BYOS-unilateral execution, amounts-only signing without `interactionsHash`, delegated collateral via an `escrow_account` field, on-chain nonce enforcement) are recorded in [contracts ADR-0005](https://github.com/bleu/byos-contracts/blob/main/docs/adr/0005-trampoline-execution-authority.md). Service-side:

- **Structured routes instead of raw interactions.** BYOS encodes every low-level call, can forbid sub-solver approvals entirely. Rejected — kills any-DEX generality, requires BYOS to maintain a venue registry, bottlenecks sub-solver innovation.
- **GET returns count only (Level 1).** Minimal leakage. Rejected — sub-solvers need per-proposal metadata to manage submissions and discover IDs for cancellation.
- **GET returns amounts (Level 2 with pricing).** Rejected — amounts reveal pricing strategy, the most competitively sensitive data.
- **Temporary suspension on simulation failure (retry loop).** Keeps failed proposals and re-simulates periodically. Rejected — adds complexity, wastes simulation cycles, and sub-solvers naturally resubmit via their polling loops.
- **Escrow slash on simulation failure.** Rejected — simulation failures are usually environmental (pool state moved, order filled elsewhere), not misbehavior, so slashing them would punish honest participants and deter permissionless participation. Debits are reserved for provable faults ([ADR-0003](0003-slash-attribution-flow.md)); spam is handled by rate limiting.
- **Synchronous ingestion (inline pipeline, verdict in the response).** The original v1 choice. Reversed during the COW-1159 review: it puts RPC calls and simulation on the public request path, ties request latency and error behavior to RPC health, and forces the inline pipeline and the re-simulation loop to exist as two code paths doing the same judgment.
- **Eager per-submission validation task (async, but validate immediately).** Rejected — two validation entry points to keep consistent for a latency win the polling loop doesn't need.
- **Single listener for both public API and /solve.** Rejected — `/solve` latency is a hard SLA.
- **Pure in-memory (no persistence).** Rejected — loses dispute evidence on restart. Track B claims arrive months later.
- **In-memory hot store (memory-only /solve, resubmission on restart).** Reversed by [ADR-0013](0013-proposal-lifecycle-and-retention.md): at actual volumes an indexed Postgres read is ~1 ms against a seconds-scale deadline.

## Consequences

- **`POST` no longer answers with a verdict.** The `id` in the `202` means "accepted for validation"; sub-solver clients must poll `GET /proposal/{id}` to learn `active`/`rejected` and read the typed `rejectionReason`.
- **Verdict latency is bounded by the validator tick interval** (default 12s), not by the request round-trip.
- **Sub-solvers must include all required interactions (hooks, approvals) in their proposals.** BYOS can reject at gatekeeping but cannot patch proposals post-submission.
- **The signing schema is an external dependency.** The `ProposalData` struct, typehash, and domain are fixed by the contracts repo; signature code in this repo must be tested against contract-provided vectors, not a local re-derivation.
- **Audit trail becomes an operational dependency for dispute resolution.** If the audit log is lost or corrupted, BYOS cannot prove attribution for Track B claims and must absorb the cost.
- **Rate limiting by escrow balance creates a pay-to-play throughput gradient.** Accepted — consistent with the collateral-gated permission model.
