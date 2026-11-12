import { describe, expect, it, vi } from "vitest";
import { createHealthApp } from "../health-app.js";
import { createSolveApp } from "../solve-app.js";
import { SolveOrderbookClient } from "../solve-orderbook-client.js";

describe("sub-solver health endpoint", () => {
	it("responds without credentials in polling mode and exposes no solve route", async () => {
		const app = createHealthApp();
		const response = await app.request("/healthz");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
		expect((await app.request("/solve", { method: "POST" })).status).toBe(404);
	});

	it("responds without submitting an auction or bypassing solve authentication", async () => {
		const client = new SolveOrderbookClient();
		const receive = vi.spyOn(client, "receive");
		const onAuction = vi.fn(async () => {});
		const app = createSolveApp(client, "secret", onAuction);
		expect((await app.request("/healthz")).status).toBe(200);
		expect(receive).not.toHaveBeenCalled();
		expect(onAuction).not.toHaveBeenCalled();
		expect((await app.request("/solve", { method: "POST" })).status).toBe(401);
	});

	it("continues responding while a solve cycle is waiting for upstream work", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = () => {};
		const cycleStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const app = createSolveApp(new SolveOrderbookClient(), "secret", async () => {
			started();
			await gate;
		});
		const cycle = app.request("/solve", {
			method: "POST",
			headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
			body: JSON.stringify({ orders: [] }),
		});
		await cycleStarted;
		try {
			expect((await app.request("/healthz")).status).toBe(200);
		} finally {
			release();
		}
		expect((await cycle).status).toBe(200);
	});
});
