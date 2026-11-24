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
			body: JSON.stringify({ id: 1, deadline: "2030-01-01T00:00:00Z", orders: [{}] }),
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
			body: JSON.stringify({ id: 1, deadline: "2030-01-01T00:00:00Z", orders: [{}] }),
		});
		expect(response.status).toBe(200);
		expect(receive).toHaveBeenCalledWith({ id: 1, deadline: "2030-01-01T00:00:00Z", orders: [{}] });
	});
});

describe("solve discovery cycles", () => {
	const request = (app: ReturnType<typeof createSolveApp>, id: number) =>
		app.request("/solve", {
			method: "POST",
			headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
			body: JSON.stringify({ id, deadline: "2030-01-01T00:00:00Z", orders: [{}] }),
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

describe("latest pending auction", () => {
	it("drops an intermediate pending push and stops the previous work context", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = () => {};
		const firstStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const contexts: import("../auction-work.js").AuctionWork[] = [];
		const received: string[] = [];
		const arrivals = new Map<string, () => void>();
		const secondArrived = new Promise<void>((resolve) => arrivals.set("2", resolve));
		const thirdArrived = new Promise<void>((resolve) => arrivals.set("3", resolve));
		const client = new SolveOrderbookClient();
		vi.spyOn(client, "receive").mockImplementation((body) =>
			received.push(String((body as { id: string }).id)),
		);
		const app = createSolveApp(
			client,
			"secret",
			async (work) => {
				contexts.push(work);
				if (work.auctionId === "1") {
					started();
					await gate;
				}
			},
			{
				logger: {
					info: (fields, message) => {
						if (message === "auction push received")
							arrivals.get((fields as { auctionId: string }).auctionId)?.();
					},
				},
			},
		);
		const push = (id: string) =>
			app.request("/solve", {
				method: "POST",
				headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
				body: JSON.stringify({
					id,
					deadline: new Date(Date.now() + 10000).toISOString(),
					orders: [{}],
				}),
			});
		const first = push("1");
		await firstStarted;
		const second = push("2");
		await secondArrived;
		const third = push("3");
		await thirdArrived;
		expect(contexts[0]?.signal.aborted).toBe(true);
		release();
		const responses = await Promise.all([first, second, third]);
		expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
		expect(received).toEqual(["1", "3"]);
		expect(contexts.map((work) => work.auctionId)).toEqual(["1", "3"]);
	});

	it("does not run expired pushes or let an older id overwrite a newer auction", async () => {
		const onAuction = vi.fn(async () => {});
		const app = createSolveApp(new SolveOrderbookClient(), "secret", onAuction);
		const push = (id: string, remaining: number) =>
			app.request("/solve", {
				method: "POST",
				headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
				body: JSON.stringify({
					id,
					deadline: new Date(Date.now() + remaining).toISOString(),
					orders: [{}],
				}),
			});
		await push("2", 10000);
		await push("1", 10000);
		await push("3", 500);
		expect(onAuction).toHaveBeenCalledTimes(1);
	});
});

describe("queued auction expiry and duplicate pushes", () => {
	it("skips a pending auction that expired while an older callback was draining", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let arrived = () => {};
		const secondArrived = new Promise<void>((resolve) => {
			arrived = resolve;
		});
		const initial = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(initial);
		const onAuction = vi.fn(async () => {
			entered();
			await gate;
		});
		const app = createSolveApp(new SolveOrderbookClient(), "secret", onAuction, {
			logger: {
				info: (fields, message) => {
					if (
						message === "auction push received" &&
						(fields as { auctionId: string }).auctionId === "2"
					)
						arrived();
				},
			},
		});
		const push = (id: string, ms: number) =>
			app.request("/solve", {
				method: "POST",
				headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
				body: JSON.stringify({ id, orders: [{}], deadline: new Date(initial + ms).toISOString() }),
			});
		const first = push("1", 10000);
		await started;
		const second = push("2", 3000);
		await secondArrived;
		try {
			clock.mockReturnValue(initial + 2500);
			release();
			await Promise.all([first, second]);
			expect(onAuction).toHaveBeenCalledTimes(1);
		} finally {
			release();
			clock.mockRestore();
		}
	});

	it("does not abort useful work when the same auction is pushed twice", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let signal: AbortSignal | undefined;
		const onAuction = vi.fn(async (work: import("../auction-work.js").AuctionWork) => {
			signal = work.signal;
			entered();
			await gate;
		});
		const app = createSolveApp(new SolveOrderbookClient(), "secret", onAuction);
		const body = JSON.stringify({
			id: "1",
			orders: [{}],
			deadline: new Date(Date.now() + 10000).toISOString(),
		});
		const push = () =>
			app.request("/solve", {
				method: "POST",
				headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
				body,
			});
		const first = push();
		await started;
		try {
			expect((await push()).status).toBe(200);
			expect(signal?.aborted).toBe(false);
			expect(onAuction).toHaveBeenCalledTimes(1);
		} finally {
			release();
			await first;
		}
	});
});

describe("empty auction forwarding", () => {
	it("does not cancel active work when BYOS forwards an unrelated empty auction", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let signal: AbortSignal | undefined;
		const onAuction = vi.fn(async (work: import("../auction-work.js").AuctionWork) => {
			signal = work.signal;
			entered();
			await gate;
		});
		const app = createSolveApp(new SolveOrderbookClient(), "secret", onAuction);
		const push = (id: string, orders: object[]) =>
			app.request("/solve", {
				method: "POST",
				headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
				body: JSON.stringify({ id, orders, deadline: new Date(Date.now() + 10000).toISOString() }),
			});
		const first = push("1", [{}]);
		await started;
		try {
			expect((await push("2", [])).status).toBe(200);
			expect(signal?.aborted).toBe(false);
			expect(onAuction).toHaveBeenCalledTimes(1);
		} finally {
			release();
			await first;
		}
	});
});

describe("expired newer auction", () => {
	it("stops stale active work even when its replacement has no usable time left", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let signal: AbortSignal | undefined;
		const onAuction = vi.fn(async (work: import("../auction-work.js").AuctionWork) => {
			signal = work.signal;
			entered();
			await gate;
		});
		const app = createSolveApp(new SolveOrderbookClient(), "secret", onAuction);
		const push = (id: string, remaining: number) =>
			app.request("/solve", {
				method: "POST",
				headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
				body: JSON.stringify({
					id,
					orders: [{}],
					deadline: new Date(Date.now() + remaining).toISOString(),
				}),
			});
		const first = push("1", 10000);
		await started;
		try {
			expect((await push("2", 100)).status).toBe(200);
			expect(signal?.aborted).toBe(true);
			expect(onAuction).toHaveBeenCalledTimes(1);
		} finally {
			release();
			await first;
		}
	});
});
