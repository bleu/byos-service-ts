# Deployment environments

`deploy.json` declares stable Compose project names and active services. It uses
JSON, so the deployment host needs only Python's standard library to parse it.
Duplicate keys are rejected.
Postgres and Redis are implicit. Dependencies must be declared explicitly.
Project renames and volume migrations are outside this deployment system.

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
