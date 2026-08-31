# ADR-0016: Operational Observability

**Status:** Accepted

## Context

As BYOS moves toward production, the team needs visibility into how the service is performing: proposal throughput, rejection breakdown, settlement success rates, penalties, and infrastructure health. The goal is to enable debugging of individual proposals and catch operational problems early.

Two approaches were considered:

- **Grafana-centric:** expose a `/metrics` endpoint with `prom-client`, scrape it with Prometheus, visualize in Grafana.
- **Custom admin dashboard:** query Postgres directly from a purpose-built Next.js app authenticated via Google OAuth.

## Decision

**Custom admin dashboard + deferred Prometheus/Grafana.**

### Why custom over Grafana

The strongest requirement is a custom debugging experience: clicking on a proposal and seeing its full audit trail, raw payload JSON, status history, and links between related records. Grafana panels cannot express this; a custom app can.

For business metrics (proposals, rejections, settlements, penalties), the `audit_events` table is the canonical record. It already contains every significant domain event, timestamped and typed, with a structured `payload` column. Querying it directly is correct, fast enough at current volumes, and adds no new infrastructure.

Grafana's Postgres datasource can run SQL panels, but the dashboard UX for domain-specific debugging is severely limited compared to a purpose-built page.

### Why Prometheus/Grafana is deferred, not rejected

Prometheus is the right tool for system metrics (CPU, memory, queue depth over time) and HTTP latency percentiles. However, standing up and maintaining a Prometheus + Grafana stack is an infrastructure project on its own. It is explicitly deferred until there is an operational need — on-call alerting, SLO tracking, anomaly detection — that the custom dashboard cannot satisfy.

When that need arises, adding `prom-client` and a `/metrics` endpoint to the byos service is a small incremental change.

## Implementation

### Access control

The admin API (port 9587) and dashboard are protected at the network level via Tailscale. Port 9587 is not exposed to the public internet — it is only reachable from inside the Docker network, where the admin Next.js container calls it directly. The Next.js container is the only public-facing entry point, exposed exclusively on the Tailscale network. Membership in the tailnet is the auth boundary.

Google OAuth was considered and prototyped but removed. It added infrastructure complexity (client ID, secret, redirect URIs, token verification) with no meaningful security gain over Tailscale network isolation for an internal tool.

### Admin API (byos, port 9587)

A third Hono app instance listens on port 9587. The port is not exposed to the host; it is only reachable from other containers on the same Docker network. No application-level authentication is applied — the network boundary is the security control.

Endpoints:

| Endpoint | What it returns |
|---|---|
| `GET /overview?range=24h\|7d\|30d` | Global proposal/settlement/penalty counts |
| `GET /subsolvers?range=24h\|7d\|30d` | Per-subsolver breakdown |
| `GET /proposals?subSolver=&status=&page=&limit=` | Paginated proposal list |
| `GET /proposals/:id` | Full proposal detail + ordered audit trail |
| `GET /system` | Live memory, CPU, BullMQ queue depths, pending penalties |

All business metrics are read from `audit_events`, `proposals`, and `penalties` — no new tables.

System metrics (`/system`) are read live from Node.js `process.memoryUsage()`, `os` module, and BullMQ queue APIs. These are point-in-time values; no history is stored. Prometheus/Grafana covers historical system metrics when that need arises.

### Admin dashboard (apps/admin)

A Next.js app with no application-level authentication. It is deployed as a Docker container on the same network as byos, calling the admin API at `http://byos-ts:9587` internally. Port 3000 is the only externally exposed port, and it is only reachable via Tailscale.

Pages:

- **Overview** — global stats with 24h/7d/30d selector
- **Subsolvers** — sortable leaderboard with per-subsolver breakdown
- **Proposals** — filterable/paginated list with status and subsolver filters
- **Proposal detail** — full audit trail in chronological order with raw payload JSON
- **System** — live memory, CPU, queue depths, pending penalties

### What this does not cover

- **Historical system metrics** (CPU/memory over time) — deferred to Prometheus when needed.
- **Alerting** — covered by ADR-0017 (Slack notifications via BullMQ).
- **Write operations** — the admin dashboard is read-only in this version.

## Consequences

- No new infrastructure dependencies beyond the existing Postgres.
- The admin port (9587) must not be exposed to the host. It is internal to the Docker network.
- The admin Next.js container must be deployed on the Tailscale network to enforce access control.
- System metrics are current-values-only until Prometheus is added.
