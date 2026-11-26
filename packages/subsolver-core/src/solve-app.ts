import type { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { createHealthApp } from "./health-app.js";
import type { SolveOrderbookClient } from "./solve-orderbook-client.js";

interface SolveAppOptions {
	logger?: { warn: (fields: object, message: string) => void };
}

/**
 * Authenticate auction pushes and start one fire-and-forget cycle per push.
 *
 * Cycles run concurrently: BYOS validates each proposal against whichever
 * auction is open when the POST arrives, so a route that outlives its auction
 * still bids in the next one. Sub-solvers deduplicate orders that are already
 * being quoted by an overlapping cycle.
 */
export function createSolveApp(
	client: SolveOrderbookClient,
	token: string,
	onAuction: () => Promise<void>,
	options: SolveAppOptions = {},
): Hono {
	if (!token) throw new Error("SUBSOLVER_BEARER is required for solve discovery");
	const app = createHealthApp();
	app.use("/solve", bearerAuth({ token }));
	app.post("/solve", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		// receive() and the synchronous start of onAuction() run in the same tick,
		// so this cycle reads this push's orders before a later push replaces them.
		client.receive(body);
		onAuction().catch((error: unknown) => {
			options.logger?.warn({ err: error }, "solve cycle failed");
		});
		return c.json({}, 200);
	});
	return app;
}
