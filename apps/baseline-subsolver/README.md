# Reference sub-solver

`apps/baseline-subsolver` is the baseline Uniswap V2 reference sub-solver. It uses
`@byos/subsolver-core` for shared BYOS and orderbook clients.

Each sub-solver identity needs its own `SUBSOLVER_PRIVATE_KEY`, Trampoline,
and escrow collateral. The BSC Fynd provider is a separate app at
`apps/fynd-subsolver`, with its own configuration, executable, Compose
profile, and logs.
