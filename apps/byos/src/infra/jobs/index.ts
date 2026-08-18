import { Queue } from "bullmq";
import { Redis } from "ioredis";

export function createRedisConnection(url: string): Redis {
	return new Redis(url, { maxRetriesPerRequest: null });
}

export interface Queues {
	validation: Queue;
	validateProposal: Queue;
	retention: Queue;
	penalty: Queue;
	audit: Queue;
}

const PREFIX = "byos";

export function createQueues(connection: Redis): Queues {
	return {
		validation: new Queue("validation", { connection, prefix: PREFIX }),
		validateProposal: new Queue("validate-proposal", { connection, prefix: PREFIX }),
		retention: new Queue("retention", { connection, prefix: PREFIX }),
		penalty: new Queue("penalty", { connection, prefix: PREFIX }),
		audit: new Queue("audit", { connection, prefix: PREFIX }),
	};
}

export interface JobSchedulerConfig {
	validationIntervalSecs: number;
	retentionSweepIntervalSecs: number;
	penaltyIntervalSecs: number;
}

export async function setupJobSchedulers(
	queues: Queues,
	config: JobSchedulerConfig,
): Promise<void> {
	await queues.validation.upsertJobScheduler("validation-tick", {
		every: config.validationIntervalSecs * 1000,
	});

	await queues.retention.upsertJobScheduler("retention-sweep", {
		every: config.retentionSweepIntervalSecs * 1000,
	});

	await queues.penalty.upsertJobScheduler("penalty-tick", {
		every: config.penaltyIntervalSecs * 1000,
	});
}
