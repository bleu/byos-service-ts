import { describe, expect, it, vi } from "vitest";
import { createSolveApp } from "../solve-app.js";
import { SolveOrderbookClient } from "../solve-orderbook-client.js";

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

	it("acknowledges a push without waiting for its cycle", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const onAuction = vi.fn(() => gate);
		const app = createSolveApp(new SolveOrderbookClient(), "secret", onAuction);
		expect((await request(app, 1)).status).toBe(200);
		expect(onAuction).toHaveBeenCalledTimes(1);
		release();
	});

	it("starts overlapping cycles concurrently, each after receiving its own push", async () => {
		const client = new SolveOrderbookClient();
		const received: number[] = [];
		vi.spyOn(client, "receive").mockImplementation((body) => {
			received.push((body as { id: number }).id);
		});
		const seen: number[][] = [];
		const onAuction = vi.fn(() => {
			seen.push([...received]);
			return new Promise<void>(() => {});
		});
		const app = createSolveApp(client, "secret", onAuction);
		expect((await request(app, 1)).status).toBe(200);
		expect((await request(app, 2)).status).toBe(200);
		expect(seen).toEqual([[1], [1, 2]]);
	});

	it("logs a failed cycle and keeps accepting pushes", async () => {
		const warn = vi.fn();
		const onAuction = vi
			.fn()
			.mockRejectedValueOnce(new Error("quote failed"))
			.mockResolvedValue(undefined);
		const app = createSolveApp(new SolveOrderbookClient(), "secret", onAuction, {
			logger: { warn },
		});
		expect((await request(app, 1)).status).toBe(200);
		expect((await request(app, 2)).status).toBe(200);
		expect(onAuction).toHaveBeenCalledTimes(2);
		expect(warn).toHaveBeenCalledWith({ err: expect.any(Error) }, "solve cycle failed");
	});
});
