# Deployment environments

`deploy.json` declares stable logical project names and active services. It uses
JSON, so the deployment host needs only Python's standard library to parse it.
Duplicate keys are rejected.
Postgres and Redis are implicit. Dependencies must be declared explicitly.
Project renames and volume migrations are outside this deployment system.

Compose project names always use `byos-<project>`. Manifest keys, env directories,
pnpm arguments and saved-state keys keep the logical name:

| Manifest key / CLI argument | Env directory | Compose project |
|---|---|---|
| `bnb-prod` | `env/bnb-prod/` | `byos-bnb-prod` |
| `bnb-staging` | `env/bnb-staging/` | `byos-bnb-staging` |
| `avax-staging` | `env/avax-staging/` | `byos-avax-staging` |
| `avax-prod` | `env/avax-prod/` | `byos-avax-prod` |

Do not add the prefix to manifest keys or rename the env directories. This mapping
is used for configuration, container ownership, logs and deployment. Removal uses
the actual Compose name retained in the project's saved snapshot.

Create an ignored `env/<project>/` directory for each declared project:

```text
env/bnb-prod/
  .env
  .env.byos
  .env.admin
  .env.fynd
  .env.fynd-subsolver
  .env.binance-subsolver
```

Only files for active services are required. Shared `.env` values:

```dotenv
POSTGRES_PASSWORD=replace-me
REDIS_PASSWORD=replace-me
POSTGRES_HOST_PORT=55432
REDIS_HOST_PORT=56379
BYOS_PUBLIC_HOST_PORT=59585
BYOS_INTERNAL_HOST_PORT=59586
FYND_HOST_PORT=53000
ADMIN_HOST_PORT=53001
FYND_SUBSOLVER_HOST_PORT=53002
BINANCE_SUBSOLVER_HOST_PORT=53003
```

Assign different host ports to staging, for example add 10000 to each production
port. Every active binding must have an explicit port. Shared credentials must be
nonempty. Use URL-safe database/Redis passwords because Compose constructs URLs
from them. Container listener ports must match the Compose targets.

Service configuration is described in [the deployment guide](deploy.md),
`.env.example`, `.env.fynd-subsolver.example`, and
`.env.binance-subsolver.example`. Fynd's file may be empty if no custom options
are needed. Do not copy secrets into documentation or commit them.

Compose interpolation and container env files are resolved per project in a clean
environment. Env files use Compose dotenv syntax, never executable shell code.
For direct inspection, avoid printing resolved configuration (it contains secrets):

```bash
PROJECT=bnb-prod docker compose --env-file env/bnb-prod/.env \
  -f docker-compose.prod-local.yml config --quiet
```

Internal API, admin dashboard, Postgres, Redis and sub-solver listeners require
appropriate host network/firewall restrictions. Network changes are deferred;
the existing machine must enforce the internal listener and Tailscale boundaries
specified by the shared specification and ADR-0016.

## Operator commands

Local prerequisites: Python 3.10+, Bash, OpenSSH, rsync, pnpm. The Hetzner host
needs Git, Python 3.10+, Bash, Docker Engine and recent
Docker Compose supporting `config --no-env-resolution` (Compose v5 is tested).
The SSH user must be able to use Docker without sudo and fetch commits using its
read-only GitHub deploy key. The checkout must have no tracked modifications.

Set only connection settings in the ignored local root `.env`:

```dotenv
DEPLOY_HOST=your-host
DEPLOY_USER=bleu
# Optional, default shown:
DEPLOY_PATH=/home/bleu/byos-service-ts
```

Your existing local `env/<project>/` directories can then be synchronized:

```bash
pnpm push-secrets                 # entire env/, preserves remote-only files
pnpm pull-secrets                 # entire env/, preserves local-only files
pnpm check-ports                  # all declared projects, no container changes
pnpm build-remote                 # resolve origin/main once; build on Hetzner
pnpm build-remote <full-sha>       # explicit revision, no CI claim
pnpm deploy bnb-prod              # current manifest services and dependencies
pnpm deploy bnb-prod byos admin   # selected services; never implies removal
pnpm logs bnb-prod byos --tail 100
pnpm delete-remote-env bnb-staging # only that env directory, no container changes
```

`pnpm build-remote` initially requires these scripts to exist at the requested
remote revision. Before PR 2 merges, test its full pushed branch commit explicitly
with `pnpm build-remote <full-pr-commit-sha>`. The bootstrap fetches that commit
and runs its scripts. A subsequent default build selects remote `origin/main`,
so use an explicit commit until the scripts reach main.

Use `bash scripts/release-remote.sh <full-sha> --all` to build and deploy the entire
manifest with one lock. CI calls this only after checks pass. Server-only entry
points `scripts/build-server.sh <sha>` and `scripts/deploy-server.sh --all`
acquire the same lock. All builds stay on Hetzner. No images are pushed to a
registry. Deploy-only checks the checkout, revision labels and both recorded image
IDs; incomplete builds require another complete build before deployment.

State and the shared lock live at `<checkout-parent>/.byos-deployment-state/`,
outside Git. The directory is mode 0700; state files are mode 0600 because they
contain resolved secrets. Keep this state for recovery. Do not edit or delete it
to bypass validation. Compose errors are suppressed because diagnostics can
contain secrets; investigate the host privately on failure. Build output streams
normally. Logs can contain application data and release their lock before following.

Every deployment preflights all declared projects. It resolves env files with no
ambient shell configuration, checks required credentials and active host ports,
and checks cross-project conflicts and host occupancy before container changes.
The resulting configuration is reused for deployment, with image IDs pinned.
Application startup still performs full Zod validation. Existing containers are
recognized by exact Compose project/service labels. For example, the admin port
for `bnb-prod` can belong to a container labelled project `byos-bnb-prod` and
service `admin`, even before the first managed deployment. Similar container names,
a different service label, or a project such as `byos-bnb-prod-other` cannot claim
that port. Preflight does not adopt containers or write management state; a
successful deployment records the declared project. Only recorded projects are
eligible for later manifest-removal reconciliation.

Existing managed snapshots using an unprefixed Compose project require explicit
migration before deployment; the scripts fail instead of creating a second project
and abandoning the old one. Port checks remain read-only.

## Reusing existing data volumes

Default volume names follow the Compose namespace, such as
`byos-bnb-prod_postgres-data` and `byos-bnb-prod_redis-data`. To keep legacy staging
data, set these optional values in **local** `env/bnb-staging/.env`, then run
`pnpm push-secrets` before merging/enabling the next automated release:

```dotenv
POSTGRES_VOLUME_NAME=byos-prod-local_postgres-data
REDIS_VOLUME_NAME=byos-prod-local_redis-data
```

The values must match the volumes mounted by staging's existing Postgres and
Redis containers. Production keeps its own default `byos-bnb-prod_*` volumes.
Before changing containers, deployment compares the resolved named volumes with
existing mounts, including stopped containers, and fails on a mismatch. It never
silently replaces an existing data mount with a fresh volume. `pnpm check-ports`
checks configuration and port ownership; this additional data-mount check happens
during deployment. No volume is renamed, copied or deleted by this setting.
Do not share a database or Redis data volume between projects.

Only `--all` reconciles explicit manifest removals. It removes deleted services
from retained projects, and runs `down` for removed managed projects, preserving
named volumes. Old snapshots allow teardown even after an env directory is gone.
Missing configuration for a declared project fails preflight and never requests
teardown. An explicit empty `projects` object removes all managed projects.
Manual service selections never remove other services or projects.

Per-project state records in-progress operations before Compose runs and records
success after it finishes. A failure leaves recovery metadata and preserves the
previous successful-release record. Fix the cause and retry the same release;
there is no automatic rollback. Removing a project's env directory while it is
still declared makes its next deployment fail until configuration is restored.
Secret sync never deletes destination-only files and does not change containers.

Run helper regressions with `pnpm test:deployment`. The Compose tests require a
recent CLI but no Docker daemon; the concurrency test uses the same OS file lock as releases. Dummy fixtures are
used throughout, never operator env files.

`pnpm test:deployment:context` additionally requires Docker Engine + BuildKit.
It exports tiny synthetic build contexts using each production Dockerfile's
ignore rules and asserts that dummy shared and service env markers are excluded.
It never sends real operator env files to the builder.

The shared service image's default health probe targets BYOS on port 9585.
Compose overrides it for both sub-solvers with `GET /healthz` on their own HTTP
listeners (Fynd 3001, Binance 3002). These listeners start after initialization
and proposal synchronization in all discovery modes: `orderbook`, `aws` and
`solve`. `SOLVE_PORT` configures the listener even in polling modes; the Compose
Binance service explicitly sets it to 3002. Host port mappings are unchanged.

The health endpoint is unauthenticated and returns only `{"status":"ok"}`. It
checks startup completion and event-loop responsiveness, not RPC, Binance, Fynd
or orderbook availability on each probe, and does not submit orders. In solve
mode, `POST /solve` still requires the configured bearer token. Polling modes
expose only the health route. Compose waits for these HTTP checks along with
BYOS/Postgres/Redis health checks. Real health checks also avoid the older Compose
`--wait` bug with explicitly disabled checks; no host-wide Compose upgrade is
needed for this change.

## Automatic releases

`.github/workflows/deploy.yml` calls the existing lint/test workflows after a push
to `main`. Only after both succeed does the deployment job read environment
secrets from `byos-deploy` and invoke the shared release command with `github.sha`.
Configure `HETZNER_SSH_PRIVATE_KEY`, `DEPLOY_HOST`, and `DEPLOY_USER` there. The
SSH key must authorize the `bleu` account on Hetzner; the machine separately needs
a read-only GitHub deploy key to fetch repository commits. Keep required reviewers
and wait timers disabled, and allow `main` if branch restrictions are enabled.

Both production and staging deploy automatically. The workflow performs SSH host
key discovery with `ssh-keyscan`, as specified in the plan; a pre-pinned host key
would require an additional trusted configuration value. Builds remain on Hetzner.
Lint/test concurrency groups use distinct prefixes and cancel only PR checks,
so called deployment gates cannot cancel each other. GitHub serializes deployment
workflow runs and the server lock also coordinates manual callers. GitHub may
replace queued pending runs when many pushes arrive; each run that executes still
deploys only its own tested SHA. There is no production approval gate or rollback.

Merge the Compose/manifest PR first and the server-command PR second. Verify a
manual build and deployment with the actual env files before merging the CI PR,
whose merge enables automatic deployment. The test workflow also exercises helper
regressions and both synthetic build contexts without production secrets.


## Avalanche deployment preparation

`avax-staging` and `avax-prod` run BYOS, admin and the Binance sub-solver, plus
implicit Postgres and Redis. Fynd and the Fynd sub-solver remain BSC-only and are
not part of either Avalanche deployment. No Fynd env files or host-port variables
are required for these projects.

Before merging the manifest change, create **both** local directories with these
files, fill their values, and run `pnpm push-secrets`:

```text
env/avax-staging/
  .env
  .env.byos
  .env.admin
  .env.binance-subsolver
env/avax-prod/
  (the same four files)
```

- Set `CHAIN_ID=43114` in all three service env files. These are two isolated
  deployments on Avalanche C-Chain mainnet; the staging name does not select Fuji.
- Configure an Avalanche RPC endpoint and the correct Escrow, TrampolineFactory,
  operator key/roles and funded collateral for each deployment. Contract deployment
  and operator funding are prerequisites, managed in `bleu/byos-contracts`.
- BYOS derives Avalanche's settlement address, WAVAX and production orderbook URL
  from the pinned CoW SDK. Set `SETTLEMENT_ADDRESS`/`ORDERBOOK_URL` when an explicit
  deployment override is needed. Binance still requires `GPV2_SETTLEMENT` in its
  own env file; it must match BYOS's settlement.
- Configure the Binance credentials and discovery mode. For `solve`, set BYOS's
  `SUBSOLVERS_ENDPOINTS=http://binance-subsolver:3002/solve` and a matching
  `SUBSOLVER_BEARER` in BYOS and Binance. For `orderbook` or `aws`, set Binance's
  `DISCOVERY_URL` for the selected chain and environment instead. Never forward
  Avalanche auctions to the absent Fynd service.
- Set `COW_EXPLORER_URL` appropriately in BYOS and admin, including a staging
  override if needed. Their native amount labels and block-explorer links use the
  shared chain registry automatically.
- Set chain-appropriate gas, block-duration, collateral and slippage settings;
  do not carry BNB-specific economic values over without review. Avalanche uses
  ordinary slippage unless an explicit correlated-asset group is added later.
- In each shared `.env`, set `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, and all six
  active host-port values: `POSTGRES_HOST_PORT`, `REDIS_HOST_PORT`,
  `BYOS_PUBLIC_HOST_PORT`, `BYOS_INTERNAL_HOST_PORT`, `ADMIN_HOST_PORT`, and
  `BINANCE_SUBSOLVER_HOST_PORT`. All four projects must use distinct host bindings.
  New Avalanche deployments use their own default data volumes; do not reuse BNB
  volume overrides.

Confirm the host has sufficient disk and memory capacity, then run
`pnpm check-ports`. Merging deploys **all four** projects; missing Avalanche env
configuration blocks the release before changing any containers. Live Avalanche
quote/swap, simulation and `/solve` verification requires the configured contracts,
credentials and chain endpoints; unit tests do not substitute for this check.
