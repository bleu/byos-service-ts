import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Db } from "../../db/index.js";
import * as store from "../storage.js";

export interface RetentionWorkerConfig {
	db: Db;
	droppedRetentionSecs: number;
	logger: Logger;
}

export function createRetentionWorker(connection: Redis, config: RetentionWorkerConfig): Worker {
	return new Worker(
		"retention",
		async () => {
			try {
				const deleted = await store.sweepDropped(config.db, config.droppedRetentionSecs);
				if (deleted > 0) {
					config.logger.info({ deleted }, "retention sweep dropped proposals");
				}
			} catch (e) {
				config.logger.error({ err: e }, "retention sweep failed");
			}
		},
		{
			connection,
			prefix: "byos",
			concurrency: 1,
		},
	);
}
