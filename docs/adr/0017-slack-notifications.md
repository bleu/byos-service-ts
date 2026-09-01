# ADR-0017: Slack Notifications

**Status:** Accepted

## Context

The team needs to be alerted in real-time when operationally significant events occur: a new subsolver connecting, a settlement succeeding or reverting, a subsolver or BYOS being penalized, and service startup. Without notifications, the only way to detect these events is by polling the admin dashboard (ADR-0016).

## Decision

Slack webhook notifications dispatched asynchronously via a dedicated BullMQ queue.

## Implementation

### Notification queue

A new `slack-notification` BullMQ queue is added alongside the existing queues. The worker posts to the Slack Incoming Webhook URL configured via `SLACK_WEBHOOK_URL`. If the env var is unset, the worker is not started and no notifications are sent.

Job options: 5 attempts, exponential backoff starting at 2 seconds. Slack outages cause retries, not failures in the domain logic.

### Dispatch point: the audit worker

The audit worker is the single dispatch point for all domain event notifications. After successfully persisting an event to Postgres, it calls `buildNotification()` and, if a message is produced, enqueues a Slack job.

This means:
- No domain code is modified to add notification logic.
- Notifications are always backed by a successfully persisted event — no message is sent for a transient in-memory event that didn't reach the audit log.
- A single file to add, change, or remove notification triggers.

Notification failures are caught and logged as `warn` — they must never cause the audit job to fail or retry.

### Events that trigger notifications

| Event | Condition | Message |
|---|---|---|
| `received` | First time this subsolver address has sent a proposal | "New subsolver connected" |
| `statusChanged → settled` | Proposal reached on-chain settlement | "Auction won — proposal settled" |
| `statusChanged → settleFailed` | Settlement transaction reverted | "Settlement reverted" |
| `penalized` | Subsolver escrow debited for revert | "Subsolver penalized" |
| `nonSettlementDebited` | Subsolver debited for abandoning a won auction | "Subsolver non-settlement debited" |
| `bufferDebited` | BYOS buffer cleared for over-collection | "BYOS buffer debited" |
| App startup | Sent directly at startup, not via audit trail | "BYOS service started" |

Events not notified: auction losses (expected, high volume), rejections (dashboard covers these), cancellations, expirations.

### New subsolver detection

A Redis set at key `byos:known-subsolvers` tracks every subsolver address that has sent at least one proposal. On each `received` event, the audit worker calls `SADD` — if the return value is 1 (new member), a notification is sent. This is O(1), adds no DB query to the audit worker's path, and survives restarts because the set lives in Redis.

### Startup notification

Sent at process startup by enqueueing directly to the `slack-notification` queue. It is not routed through the audit trail (there is no domain event for "process started"). Failure is logged as `warn` and does not abort startup.

## Consequences

- `SLACK_WEBHOOK_URL` is optional. If unset, no notifications are sent and no worker starts.
- The `byos:known-subsolvers` Redis set persists across restarts. A subsolver restart or reconnect after a previous session will not re-trigger the "new subsolver" notification — which is the correct behavior.
- Notification volume scales with settlement activity. At current volumes (few settlements per day) this is fine. If volume grows significantly, the notification logic in `buildNotification()` can be extended with throttling or batching in a single place.
