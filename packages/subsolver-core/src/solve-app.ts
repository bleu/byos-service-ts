import type { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { type AuctionWork, canSubmit, createAuctionWork } from "./auction-work.js";
import { createHealthApp } from "./health-app.js";
import type { SolveOrderbookClient } from "./solve-orderbook-client.js";

interface SolveAppOptions {
	deadlineBufferMs?: number;
	logger?: { info: (fields: object, message: string) => void };
}

/** Authenticate pushes, keep one latest pending auction, and cancel superseded work. */
export function createSolveApp(
	client: SolveOrderbookClient,
	token: string,
	onAuction: (work: AuctionWork) => Promise<void>,
	options: SolveAppOptions = {},
): Hono {
	if (!token) throw new Error("SUBSOLVER_BEARER is required for solve discovery");
	const app = createHealthApp();
	type Job = {
		body: unknown;
		scope: ReturnType<typeof createAuctionWork>;
		resolve: () => void;
		reject: (error: unknown) => void;
	};
	let pending: Job | null = null;
	let active: Job | null = null;
	let running = false;
	let latestId = -1n;
	let latestDeadlineMs = -Infinity;
	const log = (work: AuctionWork, message: string, extra: object = {}) =>
		options.logger?.info(
			{
				auctionId: work.auctionId,
				deadlineMs: work.deadlineMs,
				receivedAtMs: work.receivedAtMs,
				...extra,
			},
			message,
		);

	async function drain() {
		running = true;
		try {
			while (pending) {
				const job: Job = pending;
				pending = null;
				active = job;
				const { work } = job.scope;
				const startedAt = Date.now();
				try {
					if (canSubmit(work)) {
						log(work, "auction cycle started", { queueWaitMs: startedAt - work.receivedAtMs });
						client.receive(job.body);
						await onAuction(work);
					} else log(work, "expired auction skipped");
					job.resolve();
				} catch (error) {
					if (work.signal.aborted) job.resolve();
					else job.reject(error);
				} finally {
					log(work, "auction cycle finished", {
						elapsedMs: Date.now() - startedAt,
						aborted: work.signal.aborted,
					});
					job.scope.dispose();
					active = null;
				}
			}
		} finally {
			running = false;
		}
	}

	app.use("/solve", bearerAuth({ token }));
	app.post("/solve", async (c) => {
		const receivedAtMs = Date.now();
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (typeof body !== "object" || body === null) return c.json({ error: "invalid auction" }, 400);
		const value = body as Record<string, unknown>;
		const auctionId =
			typeof value.id === "string" || typeof value.id === "number" ? String(value.id) : "";
		const deadlineMs = typeof value.deadline === "string" ? Date.parse(value.deadline) : NaN;
		if (!/^\d+$/.test(auctionId) || !Number.isFinite(deadlineMs) || !Array.isArray(value.orders)) {
			return c.json({ error: "auction id, deadline and orders are required" }, 400);
		}
		// BYOS also forwards empty auctions without opening or replacing its active state.
		if (value.orders.length === 0) {
			options.logger?.info({ auctionId, receivedAtMs }, "empty auction push skipped");
			return c.json({}, 200);
		}
		const scope = createAuctionWork({
			auctionId,
			deadlineMs,
			receivedAtMs,
			deadlineBufferMs: options.deadlineBufferMs ?? 1000,
		});
		log(scope.work, "auction push received");
		const id = BigInt(auctionId);
		if (id < latestId || (id === latestId && deadlineMs < latestDeadlineMs)) {
			log(scope.work, "stale auction push skipped");
			scope.dispose();
			return c.json({}, 200);
		}
		if (id === latestId && deadlineMs === latestDeadlineMs) {
			log(scope.work, "duplicate auction push skipped");
			scope.dispose();
			return c.json({}, 200);
		}
		latestId = id;
		latestDeadlineMs = deadlineMs;
		active?.scope.abort();
		if (pending) {
			log(pending.scope.work, "pending auction superseded");
			pending.scope.abort();
			pending.scope.dispose();
			pending.resolve();
		}
		// Even a newer expired push means BYOS has moved past the previous auction.
		if (!canSubmit(scope.work)) {
			log(scope.work, "expired auction push skipped");
			scope.dispose();
			pending = null;
			return c.json({}, 200);
		}
		await new Promise<void>((resolve, reject) => {
			pending = { body, scope, resolve, reject };
			if (!running) void drain();
		});
		return c.json({}, 200);
	});
	return app;
}
