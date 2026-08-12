# Signature-gated, owner-scoped proposal reads

Status: accepted

Spec: docs/shared/design-document.md#proposal-api
      https://bleu.github.io/byos-docs/design-document#proposal-api

Supersedes the "GET metadata: per-proposal, no amounts" section of [ADR-0001](0001-proposal-api.md) and its "pre-settlement information leakage via GET" consequence.

## Context

The proposal GET endpoints shipped in PR #4 (COW-1159) were public, per ADR-0001: anyone could list per-order proposal metadata (id, sub-solver address, validUntil, status), and `GET /proposal/{id}` returned full amounts to any caller who knew an ID. The PR #4 review (COW-1169) reversed that stance: no proposal information should leak to other sub-solvers at all. Pre-settlement, even "which addresses are competing on which order" is competitively useful.

Callers are sub-solver servers, not browsers — machine-to-machine over TLS, no sessions.

## Decision

Every read is authenticated and owner-scoped. The `ReadAuth` bearer signature, non-owner 404 behavior, and endpoint scoping are specified in the design document (see Spec link above). This ADR records why those choices were made over the alternatives.

### Why a bearer signature with no timestamp, nonce, or path binding

- **Blast radius of a leaked token is small.** Read access to the signer's *own* proposals only — no writes, no cancellation, no funds.
- **No off-chain nonce bookkeeping**, consistent with ADR-0001's stateless stance.
- **No clock coupling.** A timestamp window would make external teams' clock drift a support burden for marginal benefit.
- The distinct `ReadAuth` typehash prevents cross-type replay.

### Why 404 and not 403 for non-owners

A 403 would be an existence oracle — anyone could probe IDs and learn how many proposals are live. The ownership check runs before the liveness check, so DELETE's 409 (already terminal) is only ever seen by the owner.

## Alternatives considered

- **Keep reads public (ADR-0001 status quo).** Rejected — full amounts behind an unauthenticated ID lookup, and pre-settlement competitor mapping via order-UID listing.
- **Timestamp with validity window in the signed message.** Rejected — the leak it defends against yields read-only access to the victim's own data, while clock-sync failure hits every honest integrator.
- **Nonce with server-side replay tracking.** Rejected — introduces per-signer state the service deliberately avoids.
- **Path binding (sign the request path).** Rejected — every read is already scoped to the signer regardless of path.
- **Keep the address path parameter on the by-sub-solver route.** Rejected — the parameter is decorative once identity comes from the signature.
- **403 for non-owner reads.** Rejected — an existence oracle.

## Consequences

- Sub-solvers must sign a `ReadAuth` message and send it on every GET. The signature is a long-lived credential; compromise grants read access to that sub-solver's proposals until key rotation.
- The order-UID listing no longer serves as a public "who is competing" view. Future public statistics are a separate API addition.
- The reference `subsolver` client and external integration docs must document the `ReadAuth` signing step.
- Replay of a captured read token is possible indefinitely within a key's lifetime. Accepted: read-only, own-data-only.
