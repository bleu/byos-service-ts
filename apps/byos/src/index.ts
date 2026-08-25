import "dotenv/config";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import pino from "pino";
import { parseConfig } from "./config.js";
import { buildContext } from "./context.js";
import { createInternalApp, createPublicApp } from "./infra/api/index.js";
import { createAuditWorker } from "./infra/jobs/audit-worker.js";
import { createBalanceRefreshWorker } from "./infra/jobs/balance-refresh.js";
import { createPenaltyWorker } from "./infra/jobs/penalty.js";
import { createRetentionWorker } from "./infra/jobs/retention.js";
import {
	createProposalValidationWorker,
	createValidationWorker,
	enqueueProposalValidation,
} from "./infra/jobs/validation.js";

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
	const cL = config.MIN_COLLATERAL ? BigInt(config.MIN_COLLATERAL) : undefined;
	if (cL === undefined) {
		throw new Error("MIN_COLLATERAL is required for buffer accounting");
	}

	const publicApp = createPublicApp({
		db: ctx.db,
		chainId: config.CHAIN_ID,
		trampolineFactory: ctx.trampolineFactory,
		maxProposalLifetimeSecs: config.MAX_PROPOSAL_LIFETIME_SECS,
		cL,
		gasPriceRef: ctx.gasPriceRef,
		solveBearerToken: config.SOLVE_BEARER_TOKEN,
		onAuditEvent: ctx.onAuditEvent,
		logger,
		rateLimiter: ctx.rateLimiter,
		balances: ctx.balances,
		rateLimits: ctx.rateLimits,
	});

	const internalApp = createInternalApp({
		db: ctx.db,
		chainId: config.CHAIN_ID,
		trampolineFactory: ctx.trampolineFactory,
		maxProposalLifetimeSecs: config.MAX_PROPOSAL_LIFETIME_SECS,
		cL,
		gasPriceRef: ctx.gasPriceRef,
		solveBearerToken: config.SOLVE_BEARER_TOKEN,
		onAuditEvent: ctx.onAuditEvent,
		logger,
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
		enqueueValidation: (proposalId) =>
			enqueueProposalValidation(ctx.queues.validateProposal, proposalId),
		onAuditEvent: ctx.onAuditEvent,
		logger: logger.child({ worker: "validation" }),
	});

	const proposalValidationWorker = createProposalValidationWorker(ctx.redis, {
		db: ctx.db,
		validator: ctx.validator,
		onAuditEvent: ctx.onAuditEvent,
		logger: logger.child({ worker: "validate-proposal" }),
	});

	const retentionWorker = createRetentionWorker(ctx.redis, {
		db: ctx.db,
		droppedRetentionSecs: config.DROPPED_RETENTION_SECS,
		logger: logger.child({ worker: "retention" }),
	});

	// Only with RPC — there is nothing to refresh balances from otherwise.
	const balanceRefreshWorker = ctx.balanceRefresh
		? createBalanceRefreshWorker(ctx.redis, ctx.balanceRefresh)
		: null;

	const penaltyWorker = ctx.operator
		? createPenaltyWorker(ctx.redis, {
				db: ctx.db,
				operator: ctx.operator,
				cL: ctx.minCollateralWei,
				onAuditEvent: ctx.onAuditEvent,
				logger: logger.child({ worker: "penalty" }),
			})
		: null;

	const workers = [
		auditWorker,
		validationWorker,
		proposalValidationWorker,
		retentionWorker,
		balanceRefreshWorker,
		penaltyWorker,
	].filter(Boolean) as import("bullmq").Worker[];

	// 7. Graceful shutdown
	const shutdown = async (signal: string) => {
		logger.info({ signal }, "shutting down");

		// Close HTTP servers
		await Promise.all([
			new Promise<void>((resolve) => (publicServer as Server).close(() => resolve())),
			new Promise<void>((resolve) => (internalServer as Server).close(() => resolve())),
		]);
		logger.info("http servers closed");

		// Close non-audit workers first (they may emit audit events during teardown)
		const nonAuditWorkers = workers.filter((w) => w !== auditWorker);
		await Promise.all(nonAuditWorkers.map((w) => w.close()));
		logger.info("background workers closed");

		// Drain the audit backlog before closing: worker.close() only finishes
		// the job in hand, and events still queued in Redis would not reach
		// Postgres until the next boot — or ever, if the deploy recreates the
		// Redis volume. Unbounded on purpose, like the Rust writer: exiting
		// with evidence unflushed is worse than a hanging shutdown.
		const auditBacklog = async () => {
			const counts = await ctx.queues.audit.getJobCounts("waiting", "active", "delayed");
			return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
		};
		let backlog = await auditBacklog();
		if (backlog > 0) {
			logger.info({ backlog }, "draining audit queue");
		}
		while (backlog > 0) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			backlog = await auditBacklog();
		}
		await auditWorker.close();
		logger.info("audit worker drained");

		// Close queues
		await Promise.all([
			ctx.queues.validation.close(),
			ctx.queues.validateProposal.close(),
			ctx.queues.retention.close(),
			ctx.queues.penalty.close(),
			ctx.queues.audit.close(),
			ctx.queues.balanceRefresh.close(),
		]);

		// Close Redis
		await Promise.all([ctx.redis.quit(), ctx.requestRedis.quit()]);
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
