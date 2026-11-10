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
