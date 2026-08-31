import os from "node:os";
import { Hono } from "hono";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import type { Db } from "../../db/index.js";
import {
	getOverviewStats,
	getProposalDetail,
	getSubsolverStats,
	listProposals,
	getPendingPenaltiesCount,
	type DateRange,
} from "../admin-storage.js";
import {
	blockExplorerAddressUrl,
	cowExplorerOrderUrl,
	formatNativeAmount,
	tenderlyTxUrl,
	txLinks,
} from "../formatters.js";

export interface AdminAppContext {
	db: Db;
	redis: Redis;
	chainId: number;
	cowExplorerUrl: string;
	queues: {
		validation: Queue;
		validateProposal: Queue;
		retention: Queue;
		penalty: Queue;
		audit: Queue;
		balanceRefresh: Queue;
	};
}

function parseDateRange(fromStr: string | undefined, toStr: string | undefined): DateRange {
	const to = toStr ? new Date(toStr) : new Date();
	const from = fromStr ? new Date(fromStr) : new Date(to.getTime() - 24 * 60 * 60 * 1000);
	return { from, to };
}

/** Creates the admin Hono app (admin-facing, port 9587). */
export function createAdminApp(ctx: AdminAppContext): Hono {
	const app = new Hono();

	// GET /healthz — for liveness probes
	app.get("/healthz", (c) => c.json({ status: "ok" }));

	// GET /overview?from=<ISO>&to=<ISO>  (default: last 24h)
	app.get("/overview", async (c) => {
		const range = parseDateRange(c.req.query("from"), c.req.query("to"));
		const stats = await getOverviewStats(ctx.db, range);
		return c.json({
			...stats,
			penalizedAmountFormatted: formatNativeAmount(stats.penalizedAmountWei, ctx.chainId),
		});
	});

	// GET /subsolvers?from=<ISO>&to=<ISO>  (default: last 24h)
	app.get("/subsolvers", async (c) => {
		const range = parseDateRange(c.req.query("from"), c.req.query("to"));
		const stats = await getSubsolverStats(ctx.db, range);
		return c.json(stats);
	});

	// GET /proposals?subSolver=&status=&page=1&limit=50
	app.get("/proposals", async (c) => {
		const subSolver = c.req.query("subSolver");
		const status = c.req.query("status");
		const page = Math.max(1, Number(c.req.query("page") ?? "1"));
		const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? "50")));

		const result = await listProposals(ctx.db, { subSolver, status, page, limit });
		const enrichedItems = result.items.map((item) => ({
			...item,
			subSolverUrl: blockExplorerAddressUrl(item.subSolver, ctx.chainId),
			orderUidUrl: cowExplorerOrderUrl(item.orderUid, ctx.cowExplorerUrl),
			tenderlyUrl: item.settlementTxHash
				? tenderlyTxUrl(item.settlementTxHash, ctx.chainId)
				: null,
		}));
		return c.json({ ...result, items: enrichedItems });
	});

	// GET /proposals/:id
	app.get("/proposals/:id", async (c) => {
		const id = Number(c.req.param("id"));
		if (!Number.isSafeInteger(id) || id <= 0) {
			return c.json({ error: "invalid proposal id" }, 400);
		}
		const detail = await getProposalDetail(ctx.db, id);
		if (!detail) {
			return c.json({ error: "not found" }, 404);
		}
		const { proposal, auditTrail } = detail;
		const enrichedProposal = {
			...proposal,
			subSolverUrl: blockExplorerAddressUrl(proposal.subSolver, ctx.chainId),
			orderUidUrl: cowExplorerOrderUrl(proposal.orderUid, ctx.cowExplorerUrl),
			...txLinks(proposal.settlementTxHash, ctx.chainId),
			penaltyTxLinks: txLinks(proposal.penaltyTxHash, ctx.chainId),
		};
		return c.json({ proposal: enrichedProposal, auditTrail });
	});

	// GET /system — live CPU, memory, disk, queue depths
	app.get("/system", async (c) => {
		const mem = process.memoryUsage();
		const totalMem = os.totalmem();
		const freeMem = os.freemem();
		const cpus = os.cpus();

		// Queue depths
		const [validation, validateProposal, retention, penalty, audit, balanceRefresh] =
			await Promise.all([
				ctx.queues.validation.getJobCounts("waiting", "active", "delayed"),
				ctx.queues.validateProposal.getJobCounts("waiting", "active", "delayed"),
				ctx.queues.retention.getJobCounts("waiting", "active", "delayed"),
				ctx.queues.penalty.getJobCounts("waiting", "active", "delayed"),
				ctx.queues.audit.getJobCounts("waiting", "active", "delayed"),
				ctx.queues.balanceRefresh.getJobCounts("waiting", "active", "delayed"),
			]);

		const pendingPenalties = await getPendingPenaltiesCount(ctx.db);

		return c.json({
			memory: {
				heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
				heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
				rssMb: Math.round(mem.rss / 1024 / 1024),
				systemTotalMb: Math.round(totalMem / 1024 / 1024),
				systemFreeMb: Math.round(freeMem / 1024 / 1024),
				systemUsedPct: Math.round(((totalMem - freeMem) / totalMem) * 100),
			},
			cpu: {
				count: cpus.length,
				model: cpus[0]?.model ?? "unknown",
			},
			queues: {
				validation,
				validateProposal,
				retention,
				penalty,
				audit,
				balanceRefresh,
			},
			pendingPenalties,
		});
	});

	return app;
}
