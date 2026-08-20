import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuditEvent } from "@byos/byos/src/domain/audit.js";
import { acceptAll } from "@byos/byos/src/domain/validator.js";
import { createInternalApp, createPublicApp } from "@byos/byos/src/infra/api/index.js";
import { createAuditWorker, enqueueAuditEvent } from "@byos/byos/src/infra/jobs/audit-worker.js";
import {
	createQueues,
	createRedisConnection,
	setupJobSchedulers,
} from "@byos/byos/src/infra/jobs/index.js";
import { createRetentionWorker } from "@byos/byos/src/infra/jobs/retention.js";
import {
	createProposalValidationWorker,
	createValidationWorker,
	enqueueProposalValidation,
} from "@byos/byos/src/infra/jobs/validation.js";
import { createTestDb, type TestContext } from "@byos/byos/test/setup.js";
import { serve } from "@hono/node-server";
import type { Worker } from "bullmq";
import type { Redis } from "ioredis";
import pino from "pino";
import type { Address } from "viem";

// --- Fixtures ---

export const CHAIN_ID = 1;
export const TRAMPOLINE_FACTORY: Address = "0x00000000000000000000000000000000000000cc";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

export interface ServiceHandle {
	publicUrl: string;
	internalUrl: string;
	ctx: TestContext;
	redis: Redis;
	shutdown: () => Promise<void>;
}

export interface ServiceOptions {
	/** Reuse an existing test DB instead of creating a new one. */
	existingDb?: TestContext;
	/** Validation tick interval in seconds (default: 999999 — effectively disabled). */
	validationIntervalSecs?: number;
	/** Retention sweep interval in seconds (default: 999999 — effectively disabled). */
	retentionSweepIntervalSecs?: number;
	/** Dropped proposal retention window in seconds (default: 0 — immediate sweep). */
	droppedRetentionSecs?: number;
}

/**
 * Boots a real BYOS service instance with HTTP servers on random ports,
 * BullMQ workers backed by Redis, and a test Postgres database.
 *
 * Returns a handle with URLs, the DB context, and a shutdown function
 * that mirrors the graceful shutdown in index.ts (drains audit queue,
 * closes workers, then connections).
 */
export async function startService(opts: ServiceOptions = {}): Promise<ServiceHandle> {
	const logger = pino({ level: "silent" });

	// Database
	const ctx = opts.existingDb ?? (await createTestDb());

	// Redis (unique prefix per instance to avoid queue name collisions)
	const redis = createRedisConnection(REDIS_URL);
	const queues = createQueues(redis);

	const gasPriceRef = { value: 10_000_000_000n };
	const cL = 10_000_000_000_000_000n;

	// Audit event handler — same as production: enqueues to BullMQ
	const onAuditEvent = (event: AuditEvent) => {
		enqueueAuditEvent(queues.audit, event).catch(() => {});
	};

	// Hono apps
	const appCtx = {
		db: ctx.db,
		chainId: CHAIN_ID,
		trampolineFactory: TRAMPOLINE_FACTORY,
		maxProposalLifetimeSecs: 300,
		cL,
		gasPriceRef,
		onAuditEvent,
	};
	const publicApp = createPublicApp(appCtx);
	const internalApp = createInternalApp({ ...appCtx, logger });

	// HTTP servers on port 0 (OS-assigned)
	const publicServer = serve({ fetch: publicApp.fetch, port: 0 });
	const internalServer = serve({ fetch: internalApp.fetch, port: 0 });

	const publicPort = (publicServer.address() as AddressInfo).port;
	const internalPort = (internalServer.address() as AddressInfo).port;

	// BullMQ workers
	const auditWorker = createAuditWorker(redis, ctx.db, logger);

	const validationWorker = createValidationWorker(redis, {
		db: ctx.db,
		validator: acceptAll,
		executingTimeoutSecs: 60,
		enqueueValidation: (proposalId) =>
			enqueueProposalValidation(queues.validateProposal, proposalId),
		onAuditEvent,
		logger: logger.child({ worker: "validation" }),
	});

	const proposalValidationWorker = createProposalValidationWorker(redis, {
		db: ctx.db,
		validator: acceptAll,
		onAuditEvent,
		logger: logger.child({ worker: "validate-proposal" }),
	});

	const retentionWorker = createRetentionWorker(redis, {
		db: ctx.db,
		droppedRetentionSecs: opts.droppedRetentionSecs ?? 0,
		logger: logger.child({ worker: "retention" }),
	});

	const workers: Worker[] = [
		auditWorker,
		validationWorker,
		proposalValidationWorker,
		retentionWorker,
	];

	// Setup job schedulers
	await setupJobSchedulers(queues, {
		validationIntervalSecs: opts.validationIntervalSecs ?? 999999,
		retentionSweepIntervalSecs: opts.retentionSweepIntervalSecs ?? 999999,
		penaltyIntervalSecs: 999999,
	});

	// Shutdown — mirrors index.ts graceful shutdown but without process.exit()
	const shutdown = async () => {
		// Close HTTP servers
		await Promise.all([
			new Promise<void>((resolve) => (publicServer as Server).close(() => resolve())),
			new Promise<void>((resolve) => (internalServer as Server).close(() => resolve())),
		]);

		// Close non-audit workers first
		const nonAuditWorkers = workers.filter((w) => w !== auditWorker);
		await Promise.all(nonAuditWorkers.map((w) => w.close()));

		// Drain audit backlog
		const auditBacklog = async () => {
			const counts = await queues.audit.getJobCounts("waiting", "active", "delayed");
			return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
		};
		let backlog = await auditBacklog();
		while (backlog > 0) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			backlog = await auditBacklog();
		}
		await auditWorker.close();

		// Close queues
		await Promise.all([
			queues.validation.close(),
			queues.validateProposal.close(),
			queues.retention.close(),
			queues.penalty.close(),
			queues.audit.close(),
		]);

		// Close Redis
		await redis.quit();
	};

	return {
		publicUrl: `http://127.0.0.1:${publicPort}`,
		internalUrl: `http://127.0.0.1:${internalPort}`,
		ctx,
		redis,
		shutdown,
	};
}

/**
 * Waits for the audit worker to drain all queued events.
 * Useful after submitting proposals to ensure audit rows are written to Postgres.
 */
export async function waitForAuditDrain(redis: Redis, timeoutMs = 5000): Promise<void> {
	const { Queue } = await import("bullmq");
	const queue = new Queue("audit", { connection: redis, prefix: "byos" });

	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const counts = await queue.getJobCounts("waiting", "active", "delayed");
		if ((counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) === 0) {
			await queue.close();
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	await queue.close();
	throw new Error("audit queue did not drain within timeout");
}
