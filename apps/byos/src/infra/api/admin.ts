import os from "node:os";
import { OAuth2Client } from "google-auth-library";
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
	type TimeRange,
} from "../admin-storage.js";

export interface AdminAppContext {
	db: Db;
	redis: Redis;
	queues: {
		validation: Queue;
		validateProposal: Queue;
		retention: Queue;
		penalty: Queue;
		audit: Queue;
		balanceRefresh: Queue;
	};
	googleClientId: string;
}

/** Verifies a Google ID token and returns the email, or null on failure. */
async function verifyGoogleToken(
	client: OAuth2Client,
	clientId: string,
	token: string,
): Promise<string | null> {
	try {
		const ticket = await client.verifyIdToken({ idToken: token, audience: clientId });
		const payload = ticket.getPayload();
		return payload?.email ?? null;
	} catch {
		return null;
	}
}

function parseTimeRange(raw: string | undefined): TimeRange {
	if (raw === "7d" || raw === "30d") return raw;
	return "24h";
}

/** Creates the admin Hono app (admin-facing, port 9587). */
export function createAdminApp(ctx: AdminAppContext): Hono {
	const app = new Hono();
	const googleClient = new OAuth2Client();

	// GET /healthz — unauthenticated, for liveness probes (registered before auth middleware)
	app.get("/healthz", (c) => c.json({ status: "ok" }));

	// Auth middleware — every admin request must carry a valid @bleu.studio Google ID token
	app.use("*", async (c, next) => {
		const authHeader = c.req.header("Authorization");
		if (!authHeader?.startsWith("Bearer ")) {
			return c.json({ error: "missing authorization header" }, 401);
		}
		const token = authHeader.slice(7);
		const email = await verifyGoogleToken(googleClient, ctx.googleClientId, token);
		if (!email) {
			return c.json({ error: "invalid token" }, 401);
		}
		if (!email.endsWith("@bleu.studio")) {
			return c.json({ error: "unauthorized domain" }, 403);
		}
		await next();
	});

	// GET /overview?range=24h|7d|30d
	app.get("/overview", async (c) => {
		const range = parseTimeRange(c.req.query("range"));
		const stats = await getOverviewStats(ctx.db, range);
		return c.json(stats);
	});

	// GET /subsolvers?range=24h|7d|30d
	app.get("/subsolvers", async (c) => {
		const range = parseTimeRange(c.req.query("range"));
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
		return c.json(result);
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
		return c.json(detail);
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
