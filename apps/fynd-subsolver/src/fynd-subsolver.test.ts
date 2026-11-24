import { byosDomain } from "@byos/common";
import type { ByosClient, FyndProvider, OrderbookOrder } from "@byos/subsolver-core";
import {
	ByosRateLimitError,
	createAuctionWork,
	OrderFilter,
	RequestBudget,
} from "@byos/subsolver-core";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { FyndSubsolver } from "./fynd-subsolver.js";

const factory = "0x0000000000000000000000000000000000000001" as const;
const logger = pino({ level: "silent" });

const config: Config = {
	solvePort: 3001,
	discoveryUrl: "http://orderbook",
	discoveryMethod: "orderbook",
	byosUrl: "http://byos",
	rpcUrl: "http://rpc",
	privateKey: "0x01",
	logLevel: "silent",
	jsonLogs: true,
	chainId: 56,
	trampolineFactory: factory,
	fyndUrl: "http://fynd",
	fyndSlippageBps: 50,
	correlatedSlippageBps: 5,
	fyndQuoteConcurrency: 1,
	fyndMaxQuoteAgeSeconds: 10,
	gpv2Settlement: "0x0000000000000000000000000000000000000002",
	byosRequestsPerMinute: 100,
	byosReadReserve: 10,
	proposalRefreshIntervalSeconds: 15,
	proposalTtlSeconds: 60,
	pollIntervalSeconds: 2,
	closeToExecutionTopN: 20,
};

function order(index: number): OrderbookOrder {
	const uid = `0x${index.toString(16).padStart(2, "0")}` as `0x${string}`;
	return {
		uid,
		sellToken: "0x0000000000000000000000000000000000000003",
		buyToken: "0x0000000000000000000000000000000000000004",
		sellAmount: 100n,
		buyAmount: 90n,
		kind: "sell",
		fullSellAmount: 100n,
		fullBuyAmount: 90n,
		estimatedNativeSurplus: 0n,
		nativeBuyValue: 0n,
		nativeSellValue: 0n,
	};
}

function subsolver(
	proposals: ReturnType<typeof vi.fn>,
	orders: readonly OrderbookOrder[],
	ready = vi.fn(async () => true),
): FyndSubsolver {
	const byos = {
		proposals,
		isTerminal: () => false,
	} as unknown as ByosClient;
	return new FyndSubsolver(
		config,
		{ solvableOrders: async () => [...orders] },
		byos,
		{ ready } as unknown as FyndProvider,
		byosDomain(56, factory),
		async () => "0x" as `0x${string}`,
		logger,
		new RequestBudget(),
		new OrderFilter({ closeToExecutionTopN: 20 }),
	);
}

describe("FyndSubsolver", () => {
	it("keeps sell-order slots when buy orders rank higher", async () => {
		const buys = Array.from({ length: 20 }, (_, i) => ({
			...order(i + 1),
			kind: "buy" as const,
			nativeBuyValue: 200n,
			nativeSellValue: 100n,
		}));
		const sell = { ...order(21), nativeBuyValue: 90n, nativeSellValue: 100n };
		const ready = vi.fn(async () => false);
		const fynd = subsolver(
			vi.fn(async () => []),
			[...buys, sell],
			ready,
		);
		await fynd.pollOnce(100n);
		expect(ready).toHaveBeenCalledOnce();
	});

	it("keeps its last known live proposals when a later synchronization fails", async () => {
		const liveOrder = order(1);
		const proposals = vi
			.fn()
			.mockResolvedValueOnce([
				{ id: 7, orderUid: liveOrder.uid, validUntil: 200n, status: "active" },
			])
			.mockRejectedValueOnce(new Error("BYOS unavailable"));
		const ready = vi.fn(async () => true);
		const fynd = subsolver(proposals, [liveOrder], ready);

		await expect(fynd.synchronize(100n)).resolves.toBe(true);
		await expect(fynd.synchronize(101n)).resolves.toBe(false);
		await fynd.pollOnce(102n);

		expect(ready).not.toHaveBeenCalled();
	});

	it("preserves the longest sibling expiry during synchronization", async () => {
		const liveOrder = order(1);
		const ready = vi.fn(async () => true);
		const solver = subsolver(
			vi.fn(async () => [
				{ id: 1, orderUid: liveOrder.uid, validUntil: 200n, status: "candidate" },
				{ id: 2, orderUid: liveOrder.uid, validUntil: 101n, status: "candidate" },
			]),
			[liveOrder],
			ready,
		);
		await solver.synchronize(100n);
		await solver.pollOnce(102n);
		expect(ready).not.toHaveBeenCalled();
	});

	it("uses the synchronized proposal list instead of reading each order", async () => {
		const orders = Array.from({ length: 25 }, (_, index) => order(index + 1));
		const proposals = vi.fn(async () =>
			orders.map((liveOrder, index) => ({
				id: index + 1,
				orderUid: liveOrder.uid,
				validUntil: 200n,
				status: "active",
			})),
		);
		const ready = vi.fn(async () => true);
		const fynd = subsolver(proposals, orders, ready);

		await fynd.synchronize(100n);
		await fynd.pollOnce(101n);

		expect(proposals).toHaveBeenCalledTimes(1);
		expect(ready).not.toHaveBeenCalled();
	});
});

describe("Fynd alternative submissions", () => {
	it("submits every alternative even when one fails simulation and applies a per-order cooldown", async () => {
		const routes = [110n, 120n, 130n].map((amount) => ({
			minBuyAmount: amount,
			quoteBuyAmount: amount,
			interactions: [],
		}));
		const quoteMany = vi.fn(async () => routes);
		const submit = vi
			.fn<ByosClient["submit"]>()
			.mockRejectedValueOnce(new Error("SimFailed"))
			.mockResolvedValueOnce(2)
			.mockResolvedValueOnce(3);
		const solver = new FyndSubsolver(
			config,
			{ solvableOrders: async () => [{ ...order(1), nativeSellValue: 10n ** 18n + 1n }] },
			{ proposals: async () => [], isTerminal: () => false, submit } as unknown as ByosClient,
			{ ready: async () => true, quoteMany } as unknown as FyndProvider,
			byosDomain(56, factory),
			async () => "0x",
			logger,
			new RequestBudget(),
			new OrderFilter({ closeToExecutionTopN: 20 }),
		);
		await solver.pollOnce(100n);
		expect(submit.mock.calls.map(([proposal]) => proposal.quoteBuyAmount)).toEqual([
			110n,
			120n,
			130n,
		]);
		expect(new Set(submit.mock.calls.map(([proposal]) => proposal.nonce)).size).toBe(3);
		await solver.pollOnce(101n);
		expect(quoteMany).toHaveBeenCalledTimes(1);
	});

	it("stops on HTTP 429 instead of spending more requests on siblings", async () => {
		const route = { minBuyAmount: 110n, quoteBuyAmount: 110n, interactions: [] };
		const submit = vi.fn<ByosClient["submit"]>().mockRejectedValue(new ByosRateLimitError(60_000));
		const solver = new FyndSubsolver(
			config,
			{ solvableOrders: async () => [{ ...order(1), nativeSellValue: 10n ** 18n + 1n }] },
			{ proposals: async () => [], isTerminal: () => false, submit } as unknown as ByosClient,
			{
				ready: async () => true,
				quoteMany: async () => [route, route, route],
			} as unknown as FyndProvider,
			byosDomain(56, factory),
			async () => "0x",
			logger,
			new RequestBudget(),
			new OrderFilter({ closeToExecutionTopN: 20 }),
		);
		await solver.pollOnce(100n);
		await solver.pollOnce(101n);
		expect(submit).toHaveBeenCalledTimes(3);
	});

	it.each([0n, 10n ** 18n - 1n, 10n ** 18n, 10n ** 18n + 1n])(
		"uses the native sell-value threshold %s for single or triple submissions",
		async (nativeSellValue) => {
			const route = { minBuyAmount: 110n, quoteBuyAmount: 110n, interactions: [] };
			const quote = vi.fn(async () => route);
			const quoteMany = vi.fn(async () => [route, route, route]);
			const submit = vi.fn<ByosClient["submit"]>(async () => 1);
			const solver = new FyndSubsolver(
				config,
				{ solvableOrders: async () => [{ ...order(1), nativeSellValue }] },
				{ proposals: async () => [], isTerminal: () => false, submit } as unknown as ByosClient,
				{ ready: async () => true, quote, quoteMany } as unknown as FyndProvider,
				byosDomain(56, factory),
				async () => "0x",
				logger,
				new RequestBudget(),
				new OrderFilter({ closeToExecutionTopN: 20 }),
			);
			await solver.pollOnce(100n);
			const large = nativeSellValue > 10n ** 18n;
			expect(submit).toHaveBeenCalledTimes(large ? 3 : 1);
			expect(quoteMany).toHaveBeenCalledTimes(large ? 1 : 0);
			expect(quote).toHaveBeenCalledTimes(large ? 0 : 1);
		},
	);

	it("counts each alternative against the submission budget", async () => {
		const route = { minBuyAmount: 110n, quoteBuyAmount: 110n, interactions: [] };
		const submit = vi.fn<ByosClient["submit"]>(async () => 1);
		const solver = new FyndSubsolver(
			config,
			{ solvableOrders: async () => [{ ...order(1), nativeSellValue: 10n ** 18n + 1n }] },
			{ proposals: async () => [], isTerminal: () => false, submit } as unknown as ByosClient,
			{
				ready: async () => true,
				quoteMany: async () => [route, route, route],
			} as unknown as FyndProvider,
			byosDomain(56, factory),
			async () => "0x",
			logger,
			new RequestBudget(4, 1),
			new OrderFilter({ closeToExecutionTopN: 20 }),
		);
		await solver.pollOnce(100n);
		expect(submit).toHaveBeenCalledTimes(2);
	});
});

describe("streaming and bounded submissions", () => {
	function setupPipeline(options: {
		concurrency?: number;
		slowQuote?: Promise<void>;
		submit: ByosClient["submit"];
		sign?: () => Promise<`0x${string}`>;
	}) {
		const orders = [1, 2, 3, 4].map((id) => ({
			...order(id),
			sellAmount: BigInt(99 + id),
			fullSellAmount: BigInt(99 + id),
		}));
		const byos = {
			proposals: async () => [],
			isTerminal: () => false,
			submit: options.submit,
		} as unknown as ByosClient;
		return new FyndSubsolver(
			{ ...config, fyndQuoteConcurrency: 8, byosSubmissionConcurrency: options.concurrency ?? 2 },
			{ solvableOrders: async () => orders },
			byos,
			{
				ready: async () => true,
				quote: async (candidate: { remainingSell: bigint }) => {
					if (options.slowQuote && candidate.remainingSell === 100n) await options.slowQuote;
					return { minBuyAmount: 110n, quoteBuyAmount: 110n, interactions: [] };
				},
			} as unknown as FyndProvider,
			byosDomain(56, factory),
			options.sign ?? (async () => "0x"),
			logger,
			new RequestBudget(),
			new OrderFilter({ closeToExecutionTopN: 20 }),
		);
	}

	it("allows two submissions in flight and never exceeds the configured limit", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let active = 0;
		let maximum = 0;
		const submit = vi.fn<ByosClient["submit"]>(async () => {
			active++;
			maximum = Math.max(maximum, active);
			try {
				await gate;
				return 1;
			} finally {
				active--;
			}
		});
		const solver = setupPipeline({ submit });
		const cycle = solver.pollOnce(100n);
		try {
			await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2), { timeout: 500 });
			expect(maximum).toBe(2);
		} finally {
			release();
			await cycle;
		}
		expect(submit).toHaveBeenCalledTimes(4);
		expect(maximum).toBe(2);
	});

	it("submits a completed order while an earlier quote is still blocked", async () => {
		let release = () => {};
		const slowQuote = new Promise<void>((resolve) => {
			release = resolve;
		});
		const submit = vi.fn<ByosClient["submit"]>(async () => 1);
		const cycle = setupPipeline({ submit, slowQuote }).pollOnce(100n);
		try {
			await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(3), { timeout: 500 });
			expect(submit.mock.calls.every(([proposal]) => proposal.orderUid !== order(1).uid)).toBe(
				true,
			);
		} finally {
			release();
			await cycle;
		}
		expect(submit).toHaveBeenCalledTimes(4);
	});

	it("never posts a signed proposal after its auction was superseded", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sign = vi.fn(async () => {
			await gate;
			return "0x" as const;
		});
		const submit = vi.fn<ByosClient["submit"]>(async () => 1);
		const scope = createAuctionWork({
			auctionId: "1",
			deadlineMs: Date.now() + 10000,
			receivedAtMs: Date.now(),
			deadlineBufferMs: 1000,
		});
		const cycle = setupPipeline({ submit, sign }).pollOnce(100n, scope.work);
		try {
			await vi.waitFor(() => expect(sign).toHaveBeenCalled(), { timeout: 500 });
			scope.abort();
			await cycle;
			expect(submit).not.toHaveBeenCalled();
		} finally {
			release();
			scope.dispose();
			await cycle;
		}
	});

	it("drops queued submissions when the remaining deadline margin is exhausted", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const initial = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(initial);
		const scope = createAuctionWork({
			auctionId: "1",
			deadlineMs: initial + 10000,
			receivedAtMs: initial,
			deadlineBufferMs: 1000,
		});
		const submit = vi.fn<ByosClient["submit"]>(async () => {
			await gate;
			return 1;
		});
		const cycle = setupPipeline({ submit, concurrency: 1 }).pollOnce(100n, scope.work);
		try {
			await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1), { timeout: 500 });
			clock.mockReturnValue(initial + 9500);
			release();
			await cycle;
			expect(submit).toHaveBeenCalledTimes(1);
		} finally {
			release();
			clock.mockRestore();
			scope.dispose();
			await cycle;
		}
	});
});
