# Service Deployment

This guide describes how to deploy the BYOS service on a production machine.

Deploy the [BYOS contracts](https://github.com/bleu/byos-contracts/blob/main/docs/deploy.md) first. You will need the Escrow and TrampolineFactory addresses before you can complete this guide.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/)
- Git

## Build the image

```bash
docker build -t byos-service:local .
```

## Configure environment variables

The deployment uses two env files and two compose-level secrets.

### Compose-level secrets

Set these in your shell or in a `.env` file at the repo root before running `docker compose`:

| Variable | Description |
|----------|-------------|
| `POSTGRES_PASSWORD` | Password for the PostgreSQL database |
| `REDIS_PASSWORD` | Password for the Redis instance |

### BYOS service — `.env.byos`

Create `.env.byos` with the values below. Use `.env.byos` in the repo root as a starting template.

#### Required

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAIN_ID` | — | EVM chain ID of the target network (e.g. `56` for BSC) |
| `RPC_URL` | — | JSON-RPC endpoint for the target chain |
| `ESCROW_ADDRESS` | — | Escrow contract address from the contracts deployment |
| `TRAMPOLINE_FACTORY` | — | TrampolineFactory contract address from the contracts deployment |
| `OPERATOR_PRIVATE_KEY` | — | Private key used to submit penalty debits on-chain |
| `SETTLEMENT_ADDRESS` | — | GPv2Settlement address on the target chain. Auto-derived for Ethereum mainnet and Gnosis Chain. Required for all other chains (e.g. BSC: `0xf553d092b50bdcbddeD1A99aF2cA29FBE5E2CB13`) |
| `DEFAULT_GAS_PRICE` | — | Gas price in wei used for penalty transaction estimation (e.g. `50000000` for BSC) |

> **Cross-repo dependency.** `OPERATOR_PRIVATE_KEY` must be the private key of the address set as `ESCROW_OPERATOR` during contract deployment.

#### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `ORDERBOOK_URL` | Derived from `CHAIN_ID` | CoW orderbook API URL. Override for barn or staging environments. |
| `SUBMITTER_ADDRESS` | — | Address used as `from` in settlement simulation. Must hold `SUBMITTER_ROLE` on the Escrow contract. If not set, a dummy address is used. |
| `MIN_COLLATERAL` | `10000000000000000` (0.01 ETH) | Minimum escrow balance in wei required to accept a proposal |
| `SOLVE_BEARER_TOKEN` | — | Bearer token required on `/solve` and `/notify` requests. **Strongly recommended in production.** |
| `SLACK_TOKEN` | — | Slack bot token for operational alerts (requires `SLACK_CHANNEL`). Recommended for production. |
| `SLACK_CHANNEL` | — | Slack channel for alerts (requires `SLACK_TOKEN`) |
| `COW_EXPLORER_URL` | `https://explorer.cow.fi` | CoW Explorer base URL. Override for non-mainnet chains (e.g. `https://explorer.cow.fi/bnb` for BSC) |
| `LOG_LEVEL` | `info` | Log verbosity: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `JSON_LOGS` | `false` | Set to `true` to emit JSON logs (recommended for cloud log aggregators) |
| `SOLVE_HOLDBACK_MS` | — | Delay in milliseconds before BYOS responds to a `/solve` request |
| `RATE_LIMIT_WINDOW_SECS` | `60` | Rate limit window in seconds |
| `RATE_LIMIT_IP_PER_WINDOW` | `6000` | Maximum requests per IP per window |
| `RATE_UNIT_WEI` | `100000000000000000` | Escrow balance in wei that buys one unit of throughput |
| `RATE_PER_UNIT` | `300` | Requests per throughput unit per window |
| `RATE_MIN_PER_WINDOW` | `120` | Minimum requests allowed per window regardless of balance |
| `RATE_MAX_PER_WINDOW` | `3000` | Maximum requests allowed per window regardless of balance |

### Admin dashboard — `.env.admin`

Create `.env.admin`. Use the template in the repo root as a starting point.

#### Required

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAIN_ID` | — | EVM chain ID of the target network |
| `RPC_URL` | — | JSON-RPC endpoint for the target chain |
| `ESCROW_ADDRESS` | — | Escrow contract address from the contracts deployment |

#### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `COW_EXPLORER_URL` | `https://explorer.cow.fi` | CoW Explorer base URL |

## Start services

```bash
docker compose -f docker-compose.prod-local.yml up byos postgres redis admin -d
```

This command starts the BYOS service, PostgreSQL, Redis, and the admin dashboard. Database migrations run automatically when the service starts.

### Port mapping

The `docker-compose.prod-local.yml` file uses offset port numbers to avoid conflicts with other local services:

| Service | Container port | Host port |
|---------|---------------|-----------|
| BYOS public API | 9585 | 59585 |
| BYOS internal API | 9586 | 59586 |
| Admin dashboard | 3000 | 53001 |
| PostgreSQL | 5432 | 55432 |
| Redis | 6379 | 56379 |

To use standard port numbers on a dedicated server, update the `ports` mappings in `docker-compose.prod-local.yml` (e.g. change `59585:9585` to `9585:9585`).

> **Security.** The BYOS internal API (port 9586) and the admin dashboard (port 53001) must not be exposed to the public internet. Use a firewall rule or a network overlay such as [Tailscale](https://tailscale.com/) to restrict access. The public API (port 59585) is the only port that should be reachable externally.

## Access logs

```bash
docker compose -f docker-compose.prod-local.yml logs -f byos
```

Replace `byos` with `admin`, `postgres`, or `redis` to view logs for other services.

## Stop and restart services

Stop all services:

```bash
docker compose -f docker-compose.prod-local.yml stop
```

Restart a single service:

```bash
docker compose -f docker-compose.prod-local.yml restart byos
```

## Verify

Check that the service is running:

```bash
curl http://localhost:59585/healthz
```

A `200 OK` response confirms the service is running and the database connection is healthy.
