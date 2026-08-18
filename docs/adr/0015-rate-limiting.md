# Two-layer rate limiting with escrow-tiered budgets

Status: accepted

Spec: docs/shared/design-document.md#proposal-api
      https://bleu.github.io/byos-docs/design-document#proposal-api

## Context

The proposal API is permissionless and internet-reachable. The specification fixes the structure — a coarse per-IP filter for floods, a per-signer limit scaled by escrow tier — and leaves the numbers as operational tuning parameters.

Two properties of the deployment shape every decision below.

The reference sub-solver does not back off. `holdsLiveProposal` swallows errors and holds optimistically, `propose` failures log and continue, and nothing reads `Retry-After`. A 429 therefore does not reduce incoming load: the client re-attempts at full rate on the next tick, so the rejection path has to stay cheap.

Reads dominate. `pollOnce` issues one `GET /proposal/{id}` per live proposal every tick, 2s by default, so a sub-solver holding 30 live proposals sends roughly 900 reads a minute while posting only for orders it has not already covered.

The Rust original has no rate limiting, so this is greenfield with no reference implementation and no tests to port.

## Decision

### Per-IP limiting lives at the Cloudflare edge

Layer 1 moves out of the codebase, in front of the public listener only — never the internal listener, which is driver-facing and latency-critical. Edge rejection costs no socket, no `ecrecover`, no Redis round trip, and no connection-pool slot.

This depends on the origin being unreachable directly, via Cloudflare Tunnel or a firewall plus Authenticated Origin Pulls. Without it, `CF-Connecting-IP` is attacker-controlled and anything keyed on it is poisoned. That is the same posture the specification already takes for the internal listener: origin enforced by network topology, not path obscurity.

A loose in-app backstop (layer 1b) remains, keyed on `CF-Connecting-IP` and falling back to the socket address, logging whenever the header is absent. It defends against our own misconfiguration — a broken origin lockdown, a tunnel replaced during a deploy — not against an attacker who beat Cloudflare. It is nearly free, since the limiter function exists for the per-signer limit regardless.

### The per-signer budget is a sliding window counter

Two fixed-window counters with weighted interpolation: O(1) memory per subject, one pipelined round trip, no Lua.

One budget covers `GET`, `POST` and `DELETE`, sized from read volume. Writes are rare at steady state and ride along inside a read-sized allowance. A one-minute window sized for sustained volume also absorbs the cold-start burst, when a fresh sub-solver sees every solvable order at once and posts them in one tick with no read traffic having consumed anything.

A denied request still increments its counter. A flooding client keeps its own budget pinned, and the rejection stays one round trip.

Both call sites share `checkLimit(key, limit, windowSecs)`, so the internals can become a token bucket later without touching either.

### The tier function is gas-independent

```
rate = clamp(floor(balance / RATE_UNIT_WEI) * RATE_PER_UNIT, MIN_RATE, MAX_RATE)
```

The tempting alternative is to reuse the reserve unit `floor(balance / threshold())` — the same integer that bounds live proposals — for symmetry with the escrow math. It is a trap. `threshold()` contains `gasPrice`, and `gasPriceRef.value` is overwritten by every auction, so a gas spike would collapse every sub-solver's allowance at once and turn a market condition into an API availability incident. Gas coupling is correct for the reserve cap and wrong for throughput.

`MAX_RATE` is load-bearing. Without it a single well-funded sub-solver's allowance can exceed the edge ceiling and starve everyone else while staying inside its own limit.

`RATE_UNIT_WEI` is not derived from `MIN_COLLATERAL`, which is an unconstrained string in the config schema and may legitimately be `0` — that would divide by zero at startup. The config schema rejects a zero rate unit outright.

### The escrow floor gate reads cache, never RPC

An unknown address is admitted at the lowest tier. An address known to be below the floor is rejected synchronously with `InsufficientEscrow`. The authoritative escrow check stays in the background validator, so ADR-0001's real property — no chain reads on the public request path — survives.

The floor is `MIN_COLLATERAL`, deliberately not the validator's `ESCROW_GAS_ESTIMATION * gasPrice + minCollateral` threshold. It must sit at or below whatever the validator enforces, so the synchronous gate can never reject a proposal the validator would have accepted.

### Balance tracking is an active set with eviction

Addresses that use the API are tracked with a last-seen timestamp in a Redis sorted set. Above the floor, an address joins a per-minute multicall refresh. Below the floor, it drops into a negative set with its own TTL and is never refreshed again.

That split is what keeps the refresh set a subset of funded addresses, bounded by real capital rather than by attacker effort. Without it, N fresh keypairs put N entries in the refresh set and the attacker owns the RPC bill.

The split alone leaves a window one refresh interval wide, in which fresh keypairs accumulate because nothing has fetched their balances yet to demote them. `BALANCE_ACTIVE_SET_MAX` closes it: the sweep trims the set to a cap, stalest first, so Redis memory is bounded by construction.

A failed escrow read is recorded as no answer, never as a zero balance. A zero would demote a funded sub-solver to the negative set on nothing worse than a dropped RPC call, and that is the one error direction that cannot be tolerated.

Eviction is after roughly an hour of inactivity. Safe by construction: `MAX_PROPOSAL_LIFETIME_SECS` is 300, so an address idle for an hour cannot still hold live proposals, and eviction can never orphan reserve accounting.

One redundancy is accepted. The validator must read balances itself to stay authoritative, so it cannot consume this cache; an active sub-solver is read about five times a minute by the validator and once by the refresh job. The cheap fix, if it ever matters, is to have the validator write through.

### Redis unavailability is 503, never 429

A store failure is not a rate-limit verdict. It surfaces as `ServiceUnavailable` with `Retry-After`, as its own kind.

This is less a rate-limiting decision than an honesty one. Redis is already a hard dependency for BullMQ, so during an outage the validator does not run and `onAuditEvent` retries twice then drops events. ADR-0001 calls the audit trail an operational dependency for dispute resolution: without it BYOS cannot prove attribution for Track B claims and absorbs the cost. Accepting proposals during a Redis outage means taking on unprovable liability to preserve an availability number that is already fictional, since nothing gets validated anyway.

Failing closed is cheap here because of the client. It catches errors, holds optimistically, and retries on the next tick, so a short blip costs one poll cycle and no lost work. `ioredis` reconnects on its own. The status split is also useful in logs: a spike in 429s is load, a spike in 503s is infrastructure.

### The limiter and the balance cache are injected

`RateLimiter` and `BalanceCache` are interfaces with Redis implementations and `allowAll` / `unknownBalances` stubs, mirroring `ValidateProposal` and `acceptAll`. Without that, `createTestApp` has no Redis and every e2e file breaks — and several of them fire dozens of requests from one signer, so a live limiter would fail them on volume even with Redis present.

## Alternatives considered

- **Sliding window log.** Exact, but memory scales with traffic rather than with subjects — one sorted set per subject plus one member per request — so an attacker inflates Redis memory directly by sending requests. Cost that grows with the attack is the wrong shape for a DDoS control, at any scale.
- **Token bucket.** Deferred, not rejected. Its advantage is explicit burst-versus-sustained separation, which is a tuning problem needing real traffic to calibrate, and which a one-minute window sized for sustained volume already absorbs. `checkLimit` is the seam that makes the swap cheap.
- **Reserve units as the rate input.** See the tier function above.
- **Separate read and write budgets per signer.** Reads and writes have different shapes, not just different costs. Rejected in favour of one budget sized from read volume.
- **In-app per-IP limiting as the primary layer 1.** Superseded by Cloudflare; retained only as a loose backstop.
- **Ponder projection of `effectiveBalance`.** Indexing `Transfer` plus `WithdrawalRequested`/`WithdrawalCancelled` gives a complete, block-granular view of every address — the only design that rejects a never-seen address on first contact with no DB write and no validator job. Rejected as disproportionate: a third deployable, a second Postgres schema, backfill and cold-start semantics, against a topology of one process and two listeners. Worth revisiting if escrow history is ever needed for dispute tooling. `effectiveBalance` is fully reconstructible from events, since it is 0 when a withdrawal is pending and `balanceOf` otherwise, and the Escrow is an ERC20.
- **A "setup sub-solver" registration endpoint.** Converts an unbounded population into a bounded, enumerable set, which is the property that makes polling cheap. Rejected — it adds an onboarding step to an API whose stated posture is permissionless and collateral-gated, and it still needs a periodic refresh to revoke, which the active set provides without the extra endpoint.
- **"Ever deposited more than X" as the gate.** Simplest possible indexing. Rejected because it never revokes: deposit, get flagged, `requestWithdrawal()`, wait the cooldown, `executeWithdrawal()`, and the address keeps its privilege forever at a net cost of gas plus one cooldown of lockup. Recycling the same capital mints one permanently-privileged identity per cooldown period.
- **`Deposited − Debited − Withdrawn` net-deposit tracking.** Closes to exactly zero on exit, since `requestWithdrawal()` withdraws the entire balance. Rejected because a sub-solver funded by an ERC20 transfer rather than a direct deposit has real `effectiveBalance` and passes the validator, but reads as zero here — so the floor gate would reject a legitimately collateralized sub-solver.
- **Validator-persisted balances only**, write-through from `EscrowValidator`'s existing per-tick map. Free, since the read already happens and `beginTick()` currently discards it. Rejected as the primary mechanism because it is a negative cache and only catches repeat offenders — an attacker using a fresh keypair per request gets a first hit every time. Still worth adding later.

## Consequences

- The Cloudflare rules live outside this repo, so they are not in git, not reviewed, and not exercised by CI. They belong in Terraform, or at minimum documented under `docs/shared/operations/`. Layer 1 does not exist yet in any deployable form — until it does, the in-app backstop is the only per-IP limit, which is not what it was sized for. Tracked in COW-1266, which also covers the origin lockdown it depends on.
- Layer 1's correctness depends on an origin lockdown this repo cannot enforce or test. The backstop's "CF-Connecting-IP absent" warning is the signal that it has broken.
- `RATE_MAX_PER_WINDOW` and the edge per-IP ceiling are set in different systems and can drift apart silently. If the edge ceiling falls below the per-signer maximum, the edge rejects traffic a well-funded sub-solver is entitled to send.
- Every constant shipped is a guess sized from the reference client's poll volume, not from measured traffic. COW-1265 is the checkpoint to revisit them before the API is publicly reachable.
- Redis gains a third role — limiter counters and the balance cache alongside BullMQ — which widens what a Redis outage takes down. Fail-closed makes that explicit rather than silent.
- The per-signer limit runs after `ecrecover`, so a flood of well-formed requests with garbage signatures is only stopped by the IP layer. That is the layering the specification prescribes.
- Rate limiting adds a Redis round trip to every public request. The internal listener is untouched.
- Testing needs a new tier. `pnpm test:redis` runs `*.redis.test.ts` against a real Redis, since the key layout, TTLs and window arithmetic are where sliding-window bugs live.
