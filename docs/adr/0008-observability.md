# ADR-0008: Observability

**Status:** Accepted

## Context

The service needs structured logging with JSON output for production and human-readable output for local development.

## Decision

**pino** for structured logging.

### Why pino

- Fast (low overhead, asynchronous serialization)
- Structured JSON output by default (production)
- `pino-pretty` for human-readable development output
- Child loggers for request-scoped and worker-scoped context

### Log levels

Controlled by `LOG_LEVEL` env var (default: `info`). Levels: `trace`, `debug`, `info`, `warn`, `error`, `fatal`.

### JSON output

Controlled by `JSON_LOGS` env var. When `true`, pino outputs JSON (for log aggregation). When `false`, uses `pino-pretty` transport (for development).

### Worker context

BullMQ workers use child loggers: `logger.child({ worker: "validation" })`. This tags every log line from that worker without manual per-call annotation.

### Audit trail

The audit trail is **not** operational logging. It's a durable BullMQ queue → Postgres pipeline for dispute evidence. Operational logs and the audit trail serve different purposes and have different retention policies.

### BullMQ observability

BullMQ provides built-in job metrics: completion/failure counts, retry counts, queue depth. These are queryable via the BullMQ API and can be exposed to monitoring dashboards.
