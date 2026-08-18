import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Db } from "../../db/index.js";
import type { AuditEvent, AuditKind } from "../../domain/audit.js";
import { insertAuditEvent } from "../audit.js";

interface SerializedAuditEvent {
	occurredAt: string;
	kind: AuditKind;
}

/**
 * BullMQ stores job data via JSON.stringify, which throws on bigint — the
 * amount fields of penalized/nonSettlementDebited and the proposal embedded
 * in received would make the enqueue reject and lose the event. Bigints
 * become decimal strings; insertAuditEvent only ever calls toString() on
 * them, so the worker side reads the converted kind unchanged.
 */
export function serializeAuditKind(kind: AuditKind): AuditKind {
	return JSON.parse(
		JSON.stringify(kind, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
	);
}

/** Creates a BullMQ worker that drains audit events to Postgres. */
export function createAuditWorker(connection: Redis, db: Db, _logger: Logger): Worker {
	return new Worker(
		"audit",
		async (job) => {
			const data = job.data as SerializedAuditEvent;
			const event: AuditEvent = {
				occurredAt: new Date(data.occurredAt),
				kind: data.kind,
			};
			await insertAuditEvent(db, event);
		},
		{
			connection,
			prefix: "byos",
			concurrency: 5,
		},
	);
}

/** Enqueues an audit event to the durable BullMQ queue. */
export async function enqueueAuditEvent(
	auditQueue: import("bullmq").Queue,
	event: AuditEvent,
): Promise<void> {
	await auditQueue.add(
		"audit-event",
		{
			occurredAt: event.occurredAt.toISOString(),
			kind: serializeAuditKind(event.kind),
		} satisfies SerializedAuditEvent,
		{
			attempts: 20,
			backoff: { type: "exponential", delay: 100 },
			removeOnFail: false,
		},
	);
}
