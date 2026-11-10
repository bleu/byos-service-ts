# Binance sub-solver

Configure the app with `.env.example` (local execution), or the root
`.env.binance-subsolver.example` for Docker Compose.

Discovery supports three modes:

- `orderbook`: poll the CoW orderbook at `DISCOVERY_URL`.
- `aws`: poll auction snapshots at `DISCOVERY_URL`.
- `solve`: receive auction pushes at `POST /solve` on `SOLVE_PORT` (default
  3001). Set `SUBSOLVER_BEARER`; callers must send
  `Authorization: Bearer <token>`. `DISCOVERY_URL` is optional in this mode.

Polling modes use `POLL_INTERVAL_SECONDS`. Solve mode processes each push,
serializes overlapping requests, and returns after its processing cycle. Its
response is an acknowledgement; proposals are submitted separately to BYOS.

All modes use the same selection as Fynd: newly seen sell orders plus the
top `CLOSE_TO_EXECUTION_TOP_N` orders by relative spread (default 20).
The first snapshot selects only the top N. Selection remembers all input UIDs,
even when BYOS backoff prevents quoting. Existing proposal refresh eligibility
still applies after selection.

Run with `docker compose --profile binance-subsolver up --build`. The caller
must be able to reach the listener: within the Compose network use
`http://binance-subsolver:3001/solve`. Publish the configured port when the
caller is outside that network. When running both sub-solvers directly on the
same host, assign different `SOLVE_PORT` values.

Both apps share the solve listener and selection components in
`packages/subsolver-core`.

## Correlated-asset slippage

`CORRELATED_SLIPPAGE_BPS` defaults to `5` (0.05%). It replaces
`BINANCE_SLIPPAGE_BPS` when both trade tokens belong to the same hardcoded
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
