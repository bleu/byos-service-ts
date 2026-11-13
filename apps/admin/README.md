# BYOS Admin Dashboard

Internal operations dashboard for the BYOS service. Read-only. Accessible only via Tailscale (see ADR-0016).

## Pages

| Page | Path | What it shows |
|---|---|---|
| Overview | `/` | Proposal funnel, settlement/penalty counts, rejection breakdown |
| Subsolvers | `/subsolvers` | Per-subsolver stats with win rate |
| Proposals | `/proposals` | Filterable/paginated proposal list |
| Proposal detail | `/proposals/:id` | Full audit trail with raw payload JSON |
| System | `/system` | Live memory, CPU, BullMQ queue depths, pending penalties |

## Running locally

```bash
# Start Postgres, recreate the disposable byos_dashboard_dev database,
# migrate it, seed dashboard data, and start the admin dev server.
pnpm admin:dev
```

Open `http://localhost:3000`.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes in production | Postgres connection URL. In local development, it defaults to `postgres://postgres:postgres@localhost:5432/byos`. `pnpm admin:dev` sets it to the disposable `byos_dashboard_dev` database. |
| `PORT` | No | Port to listen on. Default: `3000` |

## Building the Docker image

```bash
docker build -f apps/admin/Dockerfile -t byos-admin .
```

The image uses Next.js standalone output and runs on port 3000. It is deployed on the Tailscale network alongside the byos service container.

## Local fixture

`pnpm admin:dev` deliberately drops and recreates **only** the local
`byos_dashboard_dev` database. It never touches `byos_dev`. The seed contains
three deterministic sub-solvers and a small, time-relative set of proposals in
every dashboard status, with audit events and both completed and pending
penalties. It does not need the BYOS service running because the current
dashboard queries Postgres directly.

## Tenderly simulations

Click **Simulate ↗** beside a `simFailed` badge in the proposals list or detail
page. The first click requests your Tenderly **account/organization slug**,
**project slug**, and **access key**. These are saved in this browser's local
storage. Use **Tenderly settings** in the sidebar to edit or forget them.

The admin server forwards the key only for the current request to Tenderly's
[simulation API](https://github.com/Tenderly/tenderly-docs/blob/master/simulations-and-forks/reference/tenderly-simulation-api.md).
It POSTs the saved calldata, chain, block, timestamp, and any recorded code/storage
overrides; both successful and reverted simulations are saved. A new tab opens
automatically at the resulting short, private project simulation URL. Project
access in Tenderly is required to view it. If popups are blocked, the current tab
opens the result instead. API errors appear in the settings dialog for retry.

The local fixture includes a `simFailed` proposal with 50 KB of synthetic calldata.
It exercises the UI and large-payload transport; its synthetic route is expected
to revert. Tenderly API calls are real and require your key/project and quota.
No proposal or lifecycle data is changed by replaying a simulation.
