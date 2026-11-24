# Fynd sub-solver

`apps/fynd-subsolver` is the BSC-only Fynd executable. It is intentionally
separate from the baseline reference sub-solver so deployment configuration,
logs, and provider changes do not overlap.

Copy `.env.fynd-subsolver.example` and this app's `config.toml.example` to the
repository root, set the BSC endpoints, funded key, settlement address, and
`TYCHO_API_KEY`, then run:

```sh
docker compose --profile fynd-subsolver up --build
```

The sidecar runs `serve --chain bsc`. This app retries `/v1/info` during
warm-up, validates its chain and router once, and checks `/v1/health` before
requesting quotes.

`FYND_SLIPPAGE_BPS` (default `50`, or 0.5%) is passed to Fynd when
encoding the swap. Both proposal amounts, `quoteBuyAmount` and
`minBuyAmount`, use Fynd's returned `feeBreakdown.minAmountReceived`,
matching the Binance sub-solver. Slippage can change that guaranteed output,
but the two proposal amounts always remain equal.

## Correlated-asset slippage

`CORRELATED_SLIPPAGE_BPS` defaults to `5` (0.05%). It replaces
`FYND_SLIPPAGE_BPS` when both trade tokens belong to the same hardcoded
basket on the configured chain. Other pairs and chains without defined baskets
keep the ordinary slippage (default `50` bps). An explicit `0` is supported;
the correlated value is used directly, without clamping to ordinary slippage.

Both sub-solvers share the registry in
[`correlated-assets.ts`](../../packages/subsolver-core/src/correlated-assets.ts).
It initially defines ETH, USD, EUR, BTC, and BNB baskets for chain `56`.
Add another chain ID there to extend the policy for supported providers.
Address matching is case-insensitive and uses the original order tokens,
including the native BNB sentinel. Provider chain and order restrictions still apply.

Staking tokens may have accruing exchange rates. Basket membership does not
guarantee parity or available liquidity; tighter slippage can reduce successful fills.

## Alternative routes

Multiple alternatives are enabled only when the remaining sell amount is worth
**strictly more than one native token**. The shared pipeline uses
`nativeSellValue = sellAmount * sellToken.referencePrice / 10^18` (native wei),
calculated from the `/solve` token reference prices, and compares it with
`10^18`. An order at or below the threshold, or with no reference price, sends
one route. The threshold uses the remaining auction sell amount, not the
original full amount of a partially filled order. Other discovery modes use
their available native valuation and default to one route when it is missing.

Fynd returns one best route per request. Above the native-value threshold, the
sub-solver makes up to three requests: the first is unrestricted, and subsequent
requests exclude all pools used by earlier responses. It submits up to three distinct viable
routes; this is a bounded search for pool-disjoint alternatives, not a guarantee
of Fynd's global top three routes. A later quote failure preserves earlier usable
results. Duplicate calldata is not submitted repeatedly, and quote age is checked
again after alternative requests finish.

This requires route-filter support: the client and development sidecar use
Fynd `0.125.2`, matching the production sidecar version. Every route uses the
same full sell amount; these are alternatives, not partial routes to combine.

Each alternative has its own signed proposal and nonce and consumes one BYOS
submission-budget slot. BYOS simulates and selects the best eligible candidate;
a failed alternative does not discard its siblings. Posting a new proposal does
not cancel old alternatives. Withdraw an individual candidate with a signed
`DELETE /proposal/{id}`. The local order map tracks only the refresh cooldown;
HTTP 429 stops further submissions until the retry window.

## Auction deadlines and submission scheduling

In `DISCOVERY_METHOD=solve`, authenticated pushes carry an auction ID and deadline.
The listener processes one cycle at a time and retains only the newest pending
push. A newer push cancels the previous cycle's outstanding work; older auction
IDs and expired pushes are skipped. This bounds backlog without running several
competing auction cycles. Cancellation cannot undo a POST already received by
BYOS; it prevents subsequent POSTs from stale work.

Completed orders stream directly into the submission pool. They do not wait for
unrelated orders to finish quoting. The pool provides backpressure and bounds
POSTs across all orders and alternatives. Submission failures remain independent;
HTTP 429 stops queued submissions and preserves the existing retry window.

| Setting | Default | Purpose |
|---|---|---|
| `BYOS_SUBMISSION_CONCURRENCY` | `3` | Maximum simultaneous BYOS proposal POSTs per sub-solver process. |
| `SUBSOLVER_DEADLINE_BUFFER_MS` | `1000` | Stop starting POSTs this many milliseconds before the driver deadline; minimum `250`. |

No new environment setting is required. Quoting/building stops 100 ms before the
submission cutoff, so completed alternatives can still be selected and dispatched.
Routing and BYOS requests have a five-second maximum and are further bounded by the auction's
remaining time; outstanding auction work stops 200 ms before the driver deadline.
A cycle is additionally capped at 30 seconds to bound malformed distant deadlines.
These timers limit individual requests; they are not background jobs.

For Binance, the shortest routes are selected among viable builds completed before
the quote cutoff. A timed-out build does not discard other completed builds. For
Fynd, the abortable routing transport keeps earlier usable alternatives when a
later pool-exclusion request times out. It makes no retries inside a solve window;
the polling-mode SDK retains its existing retry policy. The rule enabling up to
three alternatives only above one native token remains unchanged.

The listener logs `auction push received`, `auction cycle started` (with
`queueWaitMs`), superseded/skipped pushes, and `auction cycle finished`.
Successful submissions include `auctionId`, `quoteElapsedMs`, `postElapsedMs`,
and `remainingMs`. Cycle summaries distinguish quoting `errors` from
`submissionErrors`. Use these fields to separate queue, provider, and BYOS latency.
