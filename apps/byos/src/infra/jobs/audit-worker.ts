import { Worker } from "bullmq";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Db } from "../../db/index.js";
import type { AuditEvent, AuditKind } from "../../domain/audit.js";
import { insertAuditEvent } from "../audit.js";
import { enqueueSlackNotification } from "./slack-worker.js";

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

// --- Notification dispatch ---

const KNOWN_SUBSOLVERS_KEY = "byos:known-subsolvers";

/**
 * Builds a Slack message for an audit event, or returns null if no
 * notification should be sent for this event type.
 */
async function buildNotification(
	redis: Redis,
	kind: AuditKind,
): Promise<string | null> {
	switch (kind.type) {
		case "received": {
			const isNew = await redis.sadd(KNOWN_SUBSOLVERS_KEY, kind.proposal.subSolver);
			if (isNew === 0) return null; // already seen this subsolver
			return `🆕 New subsolver connected: \`${kind.proposal.subSolver}\``;
		}
		case "penalized":
			return (
				`⚠️ Subsolver penalized\n` +
				`Subsolver: \`${kind.subSolver}\`\n` +
				`Order: \`${kind.orderUid}\`\n` +
				`Amount: ${kind.amount.toString()} wei\n` +
				`Penalty tx: \`${kind.penaltyTxHash}\``
			);
		case "nonSettlementDebited":
			return (
				`⚠️ Subsolver non-settlement debited\n` +
				`Subsolver: \`${kind.subSolver}\`\n` +
				`Order: \`${kind.orderUid}\`\n` +
				`Amount: ${kind.amount.toString()} wei\n` +
				`Penalty tx: \`${kind.penaltyTxHash}\``
			);
		case "bufferDebited":
			return (
				`💸 BYOS buffer debited\n` +
				`Subsolver: \`${kind.subSolver}\`\n` +
				`Amount: ${kind.amount.toString()} wei\n` +
				`Entries cleared: ${kind.entryCount}\n` +
				`Tx: \`${kind.clearTxHash}\``
			);
		case "statusChanged": {
			if (kind.to === "settled") {
				return (
					`✅ Auction won — proposal settled\n` +
					`Subsolver: \`${kind.subSolver}\`\n` +
					`Order: \`${kind.orderUid}\`\n` +
					`Tx: \`${kind.settlementTxHash ?? "unknown"}\``
				);
			}
			if (kind.to === "settleFailed") {
				return (
					`❌ Settlement reverted\n` +
					`Subsolver: \`${kind.subSolver}\`\n` +
					`Order: \`${kind.orderUid}\`\n` +
					`Tx: \`${kind.settlementTxHash ?? "unknown"}\``
				);
			}
			return null;
		}
		default:
			return null;
	}
}

/** Creates a BullMQ worker that drains audit events to Postgres. */
export function createAuditWorker(
	connection: Redis,
	db: Db,
	logger: Logger,
	opts: { slackQueue?: Queue; redis?: Redis } = {},
): Worker {
	return new Worker(
		"audit",
		async (job) => {
			const data = job.data as SerializedAuditEvent;
			const event: AuditEvent = {
				occurredAt: new Date(data.occurredAt),
				kind: data.kind,
			};
			await insertAuditEvent(db, event);

			// Dispatch Slack notifications after successful persistence
			if (opts.slackQueue && opts.redis) {
				try {
					const text = await buildNotification(opts.redis, event.kind);
					if (text) {
						await enqueueSlackNotification(opts.slackQueue, text);
					}
				} catch (err) {
					// Notification failure must never fail the audit job
					logger.warn({ err }, "failed to enqueue slack notification");
				}
			}
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
