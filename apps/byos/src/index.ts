import "dotenv/config";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import pino from "pino";
import type { Address } from "viem";
import { parseConfig } from "./config.js";
import { buildContext } from "./context.js";
import { createInternalApp, createPublicApp } from "./infra/api/index.js";
import { createAuditWorker } from "./infra/jobs/audit-worker.js";
import { createPenaltyWorker } from "./infra/jobs/penalty.js";
import { createRetentionWorker } from "./infra/jobs/retention.js";
import { createValidationWorker } from "./infra/jobs/validation.js";

async function main() {
	// 1. Parse config (fail-fast)
	const config = parseConfig();

	// 2. Init logger
	const logger = pino({
		level: config.LOG_LEVEL,
		...(config.JSON_LOGS ? {} : { transport: { target: "pino-pretty" } }),
	});

	// 3. Build context (DB + Redis + blockchain clients + queues)
	const ctx = await buildContext(config, logger);

	// 4. Create Hono apps
	const publicApp = createPublicApp({
		db: ctx.db,
		chainId: config.CHAIN_ID,
		trampolineFactory: config.TRAMPOLINE_FACTORY as Address,
		maxProposalLifetimeSecs: config.MAX_PROPOSAL_LIFETIME_SECS,
		gasPriceRef: ctx.gasPriceRef,
		solveBearerToken: config.SOLVE_BEARER_TOKEN,
		onAuditEvent: ctx.onAuditEvent,
	});

	const internalApp = createInternalApp({
		db: ctx.db,
		chainId: config.CHAIN_ID,
		trampolineFactory: config.TRAMPOLINE_FACTORY as Address,
		maxProposalLifetimeSecs: config.MAX_PROPOSAL_LIFETIME_SECS,
		gasPriceRef: ctx.gasPriceRef,
		solveBearerToken: config.SOLVE_BEARER_TOKEN,
		onAuditEvent: ctx.onAuditEvent,
	});

	// 5. Start HTTP servers
	const publicServer = serve({ fetch: publicApp.fetch, port: config.PUBLIC_ADDR_PORT }, (info) =>
		logger.info(`public API listening on :${info.port}`),
	);

	const internalServer = serve(
		{ fetch: internalApp.fetch, port: config.INTERNAL_ADDR_PORT },
		(info) => logger.info(`internal API listening on :${info.port}`),
	);

	// 6. Start BullMQ workers
	const auditWorker = createAuditWorker(ctx.redis, ctx.db, logger);

	const validationWorker = createValidationWorker(ctx.redis, {
		db: ctx.db,
		validator: ctx.validator,
		executingTimeoutSecs: config.EXECUTING_TIMEOUT_SECS,
		onAuditEvent: ctx.onAuditEvent,
		logger: logger.child({ worker: "validation" }),
	});

	const retentionWorker = createRetentionWorker(ctx.redis, {
		db: ctx.db,
		droppedRetentionSecs: config.DROPPED_RETENTION_SECS,
		logger: logger.child({ worker: "retention" }),
	});

	const penaltyWorker = ctx.operator
		? createPenaltyWorker(ctx.redis, {
				db: ctx.db,
				operator: ctx.operator,
				cL: BigInt(config.MIN_COLLATERAL ?? "0"),
				onAuditEvent: ctx.onAuditEvent,
				logger: logger.child({ worker: "penalty" }),
			})
		: null;

	const workers = [auditWorker, validationWorker, retentionWorker, penaltyWorker].filter(
		Boolean,
	) as import("bullmq").Worker[];

	// 7. Graceful shutdown
	const shutdown = async (signal: string) => {
		logger.info({ signal }, "shutting down");

		// Close HTTP servers
		await Promise.all([
			new Promise<void>((resolve) => (publicServer as Server).close(() => resolve())),
			new Promise<void>((resolve) => (internalServer as Server).close(() => resolve())),
		]);
		logger.info("http servers closed");

		// Close BullMQ workers (finish current job)
		await Promise.all(workers.map((w) => w.close()));
		logger.info("workers closed");

		// Close queues
		await Promise.all([
			ctx.queues.validation.close(),
			ctx.queues.retention.close(),
			ctx.queues.penalty.close(),
			ctx.queues.audit.close(),
		]);

		// Close Redis
		await ctx.redis.quit();
		logger.info("redis disconnected");

		// Close DB
		await ctx.dbClient.end();
		logger.info("database disconnected");

		process.exit(0);
	};

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
	console.error("fatal:", err);
	process.exit(1);
});
