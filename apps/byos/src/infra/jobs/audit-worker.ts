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

/** Creates a BullMQ worker that drains audit events to Postgres. */
export function createAuditWorker(connection: Redis, db: Db, _logger: Logger): Worker {
	return new Worker(
		"byos:audit",
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
			concurrency: 5,
		},
	);
}

/** Enqueues an audit event to the durable BullMQ queue. */
export async function enqueueAuditEvent(
	auditQueue: import("bullmq").Queue,
	event: AuditEvent,
): Promise<void> {
	await auditQueue.add("audit-event", {
		occurredAt: event.occurredAt.toISOString(),
		kind: event.kind,
	} satisfies SerializedAuditEvent);
}
