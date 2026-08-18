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
	balanceRefresh: Queue;
}

export function createQueues(connection: Redis): Queues {
	return {
		validation: new Queue("byos:validation", { connection }),
		validateProposal: new Queue("byos:validate-proposal", { connection }),
		retention: new Queue("byos:retention", { connection }),
		penalty: new Queue("byos:penalty", { connection }),
		audit: new Queue("byos:audit", { connection }),
		balanceRefresh: new Queue("byos:balance-refresh", { connection }),
	};
}

export interface JobSchedulerConfig {
	validationIntervalSecs: number;
	retentionSweepIntervalSecs: number;
	penaltyIntervalSecs: number;
	balanceRefreshIntervalSecs: number;
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

	await queues.balanceRefresh.upsertJobScheduler("balance-refresh-tick", {
		every: config.balanceRefreshIntervalSecs * 1000,
	});
}
