import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Db } from "../../db/index.js";
import type { AuditEvent } from "../../domain/audit.js";
import * as store from "../storage.js";

export interface StaleExecutingConfig {
	db: Db;
	executingTimeoutSecs: number;
	onAuditEvent: (event: AuditEvent) => void;
	logger: Logger;
}

export function createStaleExecutingWorker(
	connection: Redis,
	config: StaleExecutingConfig,
): Worker {
	return new Worker(
		"stale-executing",
		async () => {
			await runStaleExecutingSweep(config);
		},
		{ connection, prefix: "byos", concurrency: 1 },
	);
}

export async function runStaleExecutingSweep(config: StaleExecutingConfig): Promise<void> {
	const { db, executingTimeoutSecs, onAuditEvent, logger } = config;
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
}
