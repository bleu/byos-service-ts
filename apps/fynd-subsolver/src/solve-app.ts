import type { SolveOrderbookClient } from "@byos/subsolver-core";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";

/** Authenticate auction pushes before they can replace discovery state. */
export function createSolveApp(
	client: SolveOrderbookClient,
	token: string,
	onAuction: () => Promise<void>,
): Hono {
	if (!token) throw new Error("SUBSOLVER_BEARER is required for solve discovery");
	const app = new Hono();
	// Serialize receipt and quoting together so a later push cannot replace the
	// current cycle's orders while it is synchronizing proposal state.
	let pending = Promise.resolve();
	app.use("/solve", bearerAuth({ token }));
	app.post("/solve", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const cycle = pending.then(async () => {
			client.receive(body);
			await onAuction();
		});
		// Keep subsequent requests runnable even if a cycle fails.
		pending = cycle.catch(() => {});
		await cycle;
		return c.json({}, 200);
	});
	return app;
}
