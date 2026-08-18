import { Queue } from "bullmq";
import { Redis } from "ioredis";

export function createRedisConnection(url: string): Redis {
	return new Redis(url, { maxRetriesPerRequest: null });
}

/**
 * Connection for the request path — the rate limiter and the balance cache.
 *
 * Deliberately not the BullMQ connection above. BullMQ needs
 * `maxRetriesPerRequest: null` for its blocking commands, and that setting
 * disables ioredis' retry-count-driven flush of the offline queue: a command
 * issued while the socket is down then waits for a reconnect instead of
 * failing. On the request path that turns a Redis outage into a hung
 * request rather than the 503 ADR-0015 specifies, so here the offline queue
 * is off and every command is bounded.
 */
export function createRequestPathRedisConnection(url: string): Redis {
	return new Redis(url, {
		enableOfflineQueue: false,
		commandTimeout: REQUEST_PATH_COMMAND_TIMEOUT_MS,
	});
}

/** Bound on a single request-path Redis command. Well above a healthy
 * round trip, well below anything a caller would wait for. */
const REQUEST_PATH_COMMAND_TIMEOUT_MS = 250;

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
