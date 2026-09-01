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
# Start the byos service (provides the admin API on :9587)
docker compose up -d

# Start the admin dev server
ADMIN_API_URL=http://localhost:9587 pnpm --filter=@byos/admin dev
```

Open `http://localhost:3000`.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ADMIN_API_URL` | Yes | URL of the byos admin API. Default: `http://localhost:9587` |
| `PORT` | No | Port to listen on. Default: `3000` |

## Building the Docker image

```bash
docker build -f apps/admin/Dockerfile -t byos-admin .
```

The image uses Next.js standalone output and runs on port 3000. It is deployed on the Tailscale network alongside the byos service container.
