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
