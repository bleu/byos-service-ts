# Reference sub-solver

`apps/subsolver` is a thin executable over `@byos/subsolver-core`. Run one
process per provider identity; each identity needs its own
`SUBSOLVER_PRIVATE_KEY`, Trampoline, and escrow collateral.

Compose profiles support baseline only, Fynd only, both (enable both), or
neither (enable neither). `pnpm test:docker` checks the Fynd profile wiring
without credentials.

For a manual BSC shadow smoke test, copy `.env.fynd-subsolver.example`, then
copy `config.toml.example` to `config.toml` at the repository root and replace
its contract-address placeholders. Set the BSC orderbook/BYOS/RPC URLs, funded
signing key, `GPV2_SETTLEMENT`, and `TYCHO_API_KEY`, then run:

```sh
docker compose --profile fynd-subsolver up --build
```

Compose mounts `./config.toml` into the container. Set
`SUBSOLVER_CONFIG_PATH` to mount a TOML file from another location.

The Fynd sidecar uses `serve --chain bsc`. The executable retries `/v1/info`
during warm-up, fails on a chain/router mismatch, and gates quotes on
`/v1/health`. Never put BSC credentials in CI.
