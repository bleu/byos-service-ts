import { serve } from "@hono/node-server";
import { Hono } from "hono";

const publicApp = new Hono();
const internalApp = new Hono();

publicApp.get("/healthz", (c) => c.json({ status: "ok" }));
internalApp.get("/healthz", (c) => c.json({ status: "ok" }));

const publicPort = Number(process.env.PUBLIC_ADDR_PORT ?? 9585);
const internalPort = Number(process.env.INTERNAL_ADDR_PORT ?? 9586);

serve({ fetch: publicApp.fetch, port: publicPort }, (info) => {
	console.log(`public API listening on :${info.port}`);
});

serve({ fetch: internalApp.fetch, port: internalPort }, (info) => {
	console.log(`internal API listening on :${info.port}`);
});
