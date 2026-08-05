import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Db } from "../../db/index.js";
import type { AuditEvent } from "../../domain/audit.js";
import type { ValidateProposal } from "../../domain/validator.js";
import * as store from "../storage.js";

export interface ValidationWorkerConfig {
	db: Db;
	validator: ValidateProposal;
	executingTimeoutSecs: number;
	onAuditEvent: (event: AuditEvent) => void;
	logger: Logger;
}

export function createValidationWorker(connection: Redis, config: ValidationWorkerConfig): Worker {
	return new Worker(
		"byos:validation",
		async () => {
			await runValidationTick(config);
		},
		{
			connection,
			concurrency: 1,
		},
	);
}

async function runValidationTick(config: ValidationWorkerConfig): Promise<void> {
	const { db, validator, executingTimeoutSecs, onAuditEvent, logger } = config;

	// Signal start of tick (clears caches)
	if ("beginTick" in validator && typeof validator.beginTick === "function") {
		validator.beginTick();
	}

	// Sweep 1: Release stale executing proposals (timeout backstop)
	try {
		const released = await store.releaseStaleExecuting(db, executingTimeoutSecs);
		for (const event of released) {
			onAuditEvent(event);
		}
		if (released.length > 0) {
			logger.info({ count: released.length }, "released stale executing proposals");
		}
	} catch (e) {
		logger.error({ err: e }, "failed to release stale executing proposals");
	}

	// Sweep 2: Snapshot live proposals, expire and validate
	let live: Awaited<ReturnType<typeof store.snapshotByStatuses>>;
	try {
		live = await store.snapshotByStatuses(db, ["submitted", "active"]);
	} catch (e) {
		logger.error({ err: e }, "failed to snapshot live proposals");
		return;
	}

	const now = BigInt(Math.floor(Date.now() / 1000));
	const toValidate = [];

	// Expire proposals
	for (const proposal of live) {
		if (proposal.validUntil < now) {
			try {
				const result = await store.transition(db, proposal, "expired");
				if ("auditEvent" in result) {
					onAuditEvent(result.auditEvent);
				}
			} catch (e) {
				logger.debug({ err: e, id: proposal.id }, "expire transition lost");
			}
		} else {
			toValidate.push(proposal);
		}
	}

	// Sweep 3: Validate remaining proposals
	await Promise.all(
		toValidate.map(async (proposal) => {
			try {
				const verdict = await validator.validate(proposal);
				if (!verdict) {
					logger.debug({ id: proposal.id }, "validator deferred judgment");
					return;
				}

				const result = await store.resolveVerdict(db, proposal.id, verdict);
				if ("kind" in result) {
					// Store error
					if (result.kind === "staleTransition" || result.kind === "notFound") {
						logger.debug({ id: proposal.id, error: result }, "verdict transition lost");
					} else {
						logger.warn({ id: proposal.id, error: result }, "verdict resolution failed");
					}
					return;
				}

				if (result.auditEvent) {
					onAuditEvent(result.auditEvent);
				}
			} catch (e) {
				logger.warn({ err: e, id: proposal.id }, "validation failed");
			}
		}),
	);
}
