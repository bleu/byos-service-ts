# Deployment environments

`deploy.yml` declares stable Compose project names and active services. It uses
JSON syntax (a YAML subset), so the deployment host needs only Python's standard
library to parse it. Keep that syntax when editing; duplicate keys are rejected.
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
recognized by exact Compose project/service labels and managed state, never by
name prefix. Deploying into an unmanaged existing project is deliberately blocked
when its ports are occupied; use fresh project names or perform a planned manual
migration rather than stopping unknown containers automatically.

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

The shared service image's default health probe targets BYOS on port 9585. It is
disabled for sub-solver commands, which can run without an HTTP listener in polling
mode. Deploy waits for their containers to run, while BYOS/Postgres/Redis must
pass their health checks. Binance's solve listener is explicitly set to 3002 to
match its Compose target; Fynd's target remains 3001.

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
