import { Hono } from "hono";

/** Served after startup completes. Probes never make upstream requests. */
export function createHealthApp(): Hono {
	const app = new Hono();
	app.get("/healthz", (c) => c.json({ status: "ok" }));
	return app;
}
