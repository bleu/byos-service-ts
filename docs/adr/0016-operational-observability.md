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

### Admin API (byos, port 9587)

A third Hono app instance listens on port 9587. Every request (except `/healthz`) must carry a valid Google ID token as a Bearer token; the service verifies it using `google-auth-library` and rejects tokens whose email does not end in `@bleu.studio`.

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

### Google token validation

Token verification uses `google-auth-library`'s `OAuth2Client.verifyIdToken()`. The library caches Google's public JWKS keys automatically (TTL-driven, rotates ~every 6 hours). Per-request cost is a single RSA signature verification — sub-millisecond, negligible.

The port must be publicly reachable so the Next.js admin app (deployed independently) can call it from anywhere. Auth is the security boundary; no IP allowlisting is required beyond standard firewall hygiene.

### Admin dashboard (apps/admin)

A Next.js app with Google OAuth via NextAuth v5. Access is restricted to `@bleu.studio` accounts in both the NextAuth `signIn` callback and the byos admin port middleware (defense in depth).

The Google ID token from the NextAuth JWT is forwarded as a Bearer token on every API call to the byos admin port.

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

- No new infrastructure dependencies beyond the existing Postgres and the Google OAuth credentials.
- The admin port (9587) must be exposed and reachable from wherever `apps/admin` is deployed.
- `GOOGLE_CLIENT_ID` must be set in the byos environment for the admin API to start. If unset, the port is disabled and a warning is logged.
- System metrics are current-values-only until Prometheus is added.
