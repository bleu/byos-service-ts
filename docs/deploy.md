# Service Deployment

This guide describes how to deploy the BYOS service on a production machine.

Deploy the [BYOS contracts](https://github.com/bleu/byos-contracts/blob/main/docs/deploy.md) first. You will need the Escrow and TrampolineFactory addresses before you can complete this guide.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/)
- Git

## Build the images

Build the BYOS service image:

```bash
docker build -t byos-service:local .
```

Build the admin dashboard image (must be rebuilt separately whenever admin code changes):

```bash
docker compose -f docker-compose.prod-local.yml build admin
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
| `SELECTOR_BUFFER_MS` | `100` | Safety margin in milliseconds subtracted from the driver-supplied deadline before running the proposal selector |
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

The `docker-compose.prod-local.yml` file uses the following default host ports.
Set any override in the **repo-root `.env` file**; all six variables belong in
that file, rather than `.env.byos`, `.env.admin`, or a sub-solver env file.
Service `env_file` entries configure containers and do not supply Compose port
interpolation values.

| Service | Container port | Default host port | Variable in `.env` |
|---------|---------------|-------------------|--------------------|
| BYOS public API | 9585 | 59585 | `BYOS_PUBLIC_HOST_PORT` |
| BYOS internal API | 9586 | 59586 | `BYOS_INTERNAL_HOST_PORT` |
| Admin dashboard | 3000 | 53001 | `ADMIN_HOST_PORT` |
| PostgreSQL | 5432 | 55432 | `POSTGRES_HOST_PORT` |
| Redis | 6379 | 56379 | `REDIS_HOST_PORT` |
| Fynd | 3000 | 53000 | `FYND_HOST_PORT` |

For example, to publish the admin dashboard on port 53002:

```dotenv
ADMIN_HOST_PORT=53002
```

Then run `docker compose -f docker-compose.prod-local.yml up -d admin` to
recreate its port mapping. No image rebuild is needed. Unset or empty variables
use the defaults. Container ports and URLs between containers stay the same.
Shell environment variables take precedence over `.env`. To use a different
Compose env file, pass it explicitly:

```bash
docker compose --env-file env/bnb-staging/.env -f docker-compose.prod-local.yml up -d
```

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

## Redis memory and job history

The prod-local Redis container has a 1 GiB memory limit and a 512 MiB Redis
`maxmemory` limit. The remaining headroom covers Redis overhead and persistence
work; monitor actual usage during background saves. `noeviction` protects
BullMQ queue keys. The authenticated health check allows three minutes for
persisted data to load before counting failures.

Scheduled queues keep at most 100 completed jobs (up to one day) and 1,000
failed jobs (up to seven days). Failed Slack jobs use the same failure limit.
Successful audit jobs are removed after their events reach Postgres; failed
audit jobs are retained for recovery because they may contain unpersisted
evidence. Per-proposal validation jobs are removed on completion or failure.
Age-based removal occurs when another job finishes, rather than on a timer.
The proposal retention sweep applies to Postgres, separately from this policy.

Existing completed job history can be inspected and cleaned after deploying
an image containing the Redis history command:

```bash
# Read-only: Redis memory and completed/failed/pending counts per queue.
docker compose -f docker-compose.prod-local.yml exec byos \
  node apps/byos/dist/redis-history.js

# Remove completed jobs older than one hour in batches of 100.
docker compose -f docker-compose.prod-local.yml exec byos \
  node apps/byos/dist/redis-history.js --apply
```

The cleanup preserves all failed jobs, pending jobs, scheduler definitions and
the known-sub-solvers set. New retention settings trim operational failures
as subsequent jobs fail; existing failed audit jobs require explicit recovery
or archival. A growing failed audit count or pending backlog still requires
investigation rather than more memory. Do not delete Redis keys directly or
remove the data volume to reclaim completed history.

To apply the resource and policy changes without removing persisted data:

```bash
docker build -t byos-service:local .
docker compose -f docker-compose.prod-local.yml up -d redis byos
```
