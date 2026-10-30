import { SolveOrderbookClient } from "@byos/subsolver-core";
import { describe, expect, it, vi } from "vitest";
import { createSolveApp } from "./solve-app.js";

describe("solve discovery authentication", () => {
	it.each([
		[undefined, 401],
		["Bearer wrong", 401],
		["Basic secret", 400],
	] as const)("rejects %s without replacing orders", async (authorization, status) => {
		const client = new SolveOrderbookClient();
		const receive = vi.spyOn(client, "receive");
		const app = createSolveApp(
			client,
			"secret",
			vi.fn(async () => {}),
		);
		const response = await app.request("/solve", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(authorization ? { Authorization: authorization } : {}),
			},
			body: JSON.stringify({ orders: [] }),
		});
		expect(response.status).toBe(status);
		expect(receive).not.toHaveBeenCalled();
	});

	it("accepts an authenticated auction", async () => {
		const client = new SolveOrderbookClient();
		const receive = vi.spyOn(client, "receive");
		const app = createSolveApp(
			client,
			"secret",
			vi.fn(async () => {}),
		);
		const response = await app.request("/solve", {
			method: "POST",
			headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
			body: JSON.stringify({ orders: [] }),
		});
		expect(response.status).toBe(200);
		expect(receive).toHaveBeenCalledWith({ orders: [] });
	});
});

describe("solve discovery cycles", () => {
	const request = (app: ReturnType<typeof createSolveApp>, id: number) =>
		app.request("/solve", {
			method: "POST",
			headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
			body: JSON.stringify({ id, orders: [] }),
		});

	it("runs once per push and serializes overlapping auctions", async () => {
		const client = new SolveOrderbookClient();
		const received: number[] = [];
		vi.spyOn(client, "receive").mockImplementation((body) => {
			received.push((body as { id: number }).id);
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started: () => void = () => {};
		const firstStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const onAuction = vi.fn(async () => {
			if (received.length === 1) {
				started();
				await gate;
				expect(received).toEqual([1]);
			}
		});
		const app = createSolveApp(client, "secret", onAuction);
		const first = request(app, 1);
		await firstStarted;
		const second = request(app, 2);
		await Promise.resolve();
		expect(onAuction).toHaveBeenCalledTimes(1);
		release();
		expect((await first).status).toBe(200);
		expect((await second).status).toBe(200);
		expect(received).toEqual([1, 2]);
		expect(onAuction).toHaveBeenCalledTimes(2);
	});

	it("processes the next push after a cycle fails", async () => {
		const onAuction = vi
			.fn()
			.mockRejectedValueOnce(new Error("quote failed"))
			.mockResolvedValue(undefined);
		const app = createSolveApp(new SolveOrderbookClient(), "secret", onAuction);
		app.onError((_err, c) => c.body(null, 500));
		expect((await request(app, 1)).status).toBe(500);
		expect((await request(app, 2)).status).toBe(200);
		expect(onAuction).toHaveBeenCalledTimes(2);
	});
});
