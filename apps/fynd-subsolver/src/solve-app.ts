import type { SolveOrderbookClient } from "@byos/subsolver-core";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";

/** Authenticate auction pushes before they can replace discovery state. */
export function createSolveApp(client: SolveOrderbookClient, token: string): Hono {
	if (!token) throw new Error("SUBSOLVER_BEARER is required for solve discovery");
	const app = new Hono();
	app.use("/solve", bearerAuth({ token }));
	app.post("/solve", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		client.receive(body);
		return c.json({}, 200);
	});
	return app;
}
