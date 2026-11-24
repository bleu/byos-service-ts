import { byosDomain } from "@byos/common";
import type { ByosClient, OrderbookOrder } from "@byos/subsolver-core";
import {
	ByosRateLimitError,
	createAuctionWork,
	OrderFilter,
	RequestBudget,
} from "@byos/subsolver-core";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { BinanceClient } from "./binance-client.js";
import { BinanceSubsolver } from "./binance-subsolver.js";
import type { Config } from "./config.js";

const factory = "0x0000000000000000000000000000000000000001" as const;
const trampolineAddress = "0x0000000000000000000000000000000000000005" as const;
const logger = pino({ level: "silent" });

const config: Config = {
	solvePort: 3001,
	discoveryMethod: "orderbook",
	discoveryUrl: "http://orderbook",
	byosUrl: "http://byos",
	rpcUrl: "http://rpc",
	privateKey: "0x01",
	logLevel: "silent",
	jsonLogs: true,
	chainId: 56,
	trampolineFactory: factory,
	binanceApiKey: "key",
	binanceSecretKey: "secret",
	gpv2Settlement: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
	binanceSlippageBps: 50,
	correlatedSlippageBps: 5,
	binanceQuoteConcurrency: 1,
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
): BinanceSubsolver {
	const byos = {
		proposals,
		isTerminal: () => false,
	} as unknown as ByosClient;
	const binanceClient = {
		getQuote: vi.fn(async () => null),
	} as unknown as BinanceClient;
	return new BinanceSubsolver(
		config,
		{ solvableOrders: async () => [...orders] },
		byos,
		binanceClient,
		trampolineAddress,
		byosDomain(56, factory),
		async () => "0x" as `0x${string}`,
		logger,
		new RequestBudget(),
		new OrderFilter({ closeToExecutionTopN: config.closeToExecutionTopN }),
	);
}

describe("BinanceSubsolver", () => {
	it("keeps its last known live proposals when a later synchronization fails", async () => {
		const liveOrder = order(1);
		const proposals = vi
			.fn()
			.mockResolvedValueOnce([
				{ id: 7, orderUid: liveOrder.uid, validUntil: 200n, status: "active" },
			])
			.mockRejectedValueOnce(new Error("BYOS unavailable"));
		const solver = subsolver(proposals, [liveOrder]);

		await expect(solver.synchronize(100n)).resolves.toBe(true);
		await expect(solver.synchronize(101n)).resolves.toBe(false);
		// pollOnce should not call Binance since the order is already live
		await solver.pollOnce(102n);

		// proposals() called twice (sync + failed sync), Binance never queried
		expect(proposals).toHaveBeenCalledTimes(2);
	});

	it("uses the synchronized proposal list instead of re-quoting each order", async () => {
		const orders = Array.from({ length: 25 }, (_, index) => order(index + 1));
		const proposals = vi.fn(async () =>
			orders.map((liveOrder, index) => ({
				id: index + 1,
				orderUid: liveOrder.uid,
				validUntil: 200n,
				status: "active",
			})),
		);
		const solver = subsolver(proposals, orders);

		await solver.synchronize(100n);
		await solver.pollOnce(101n);

		// proposals() called once; all orders are live so Binance skips them
		expect(proposals).toHaveBeenCalledTimes(1);
	});
});

describe("Binance correlated slippage", () => {
	const usdt = "0x55d398326f99059ff775485246999027b3197955" as const;
	const usdc = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d" as const;
	const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c" as const;

	it.each([
		{ chainId: 56, correlatedSlippageBps: 5, expected: 5 },
		{ chainId: 56, correlatedSlippageBps: 0, expected: 0 },
		{ chainId: 56, correlatedSlippageBps: 7, expected: 7 },
		{ chainId: 1, correlatedSlippageBps: 5, expected: 80 },
	])(
		"uses $expected bps for stablecoin pairs on chain $chainId and preserves parallel unrelated quotes",
		async ({ chainId, correlatedSlippageBps, expected }) => {
			const cfg = {
				...config,
				chainId,
				correlatedSlippageBps,
				binanceSlippageBps: 80,
				binanceQuoteConcurrency: 2,
			};
			const orders = [
				{ ...order(1), sellToken: usdt, buyToken: usdc },
				{ ...order(2), sellToken: usdt, buyToken: wbnb },
			];
			const quotes = ["quote-1", "quote-2"].map((quoteId) => ({
				quoteId,
				vendorName: "test",
				executionMode: "SWAP" as const,
				binanceChainId: String(chainId),
				fromTokenAmount: "100",
				toTokenAmount: "120",
				tradeFee: "0",
				estimateGasFee: "0",
				priceImpactPercent: "0",
				router: factory,
				approveTarget: factory,
				isBest: true,
				feeAmount: null,
				feeToken: null,
				actualSwapAmount: null,
			}));
			const getQuotes = vi.fn<BinanceClient["getQuotes"]>(async () => quotes);
			const buildSwap = vi.fn<BinanceClient["buildSwap"]>(async () => ({
				from: trampolineAddress,
				to: factory,
				data: "0xdead",
				value: "0",
				gas: "1",
				gasPrice: "1",
				minReceiveAmount: "110",
				slippagePercent: "0.05",
			}));
			const submit = vi.fn<ByosClient["submit"]>(async () => 1);
			const byos = {
				proposals: async () => [],
				isTerminal: () => false,
				submit,
			} as unknown as ByosClient;
			const subSolver = new BinanceSubsolver(
				cfg,
				{ solvableOrders: async () => orders },
				byos,
				{ getQuotes, buildSwap } as unknown as BinanceClient,
				trampolineAddress,
				byosDomain(chainId, factory),
				async () => "0x",
				logger,
				new RequestBudget(),
				new OrderFilter({ closeToExecutionTopN: 20 }),
			);
			await subSolver.pollOnce(100n);
			expect(getQuotes).toHaveBeenCalledTimes(2);
			expect(buildSwap).toHaveBeenCalledTimes(4);
			for (const [buyToken, bps] of [
				[usdc, expected],
				[wbnb, 80],
			] as const) {
				expect(getQuotes).toHaveBeenCalledWith(
					usdt,
					buyToken,
					100n,
					trampolineAddress,
					bps,
					undefined,
				);
				for (const quote of quotes) {
					expect(buildSwap).toHaveBeenCalledWith(
						quote.quoteId,
						usdt,
						buyToken,
						100n,
						trampolineAddress,
						bps,
						undefined,
					);
				}
			}
			expect(submit).toHaveBeenCalledTimes(2);
			for (const [proposal] of submit.mock.calls) {
				expect(proposal).toMatchObject({ minBuyAmount: 110n, quoteBuyAmount: 110n });
			}
		},
	);
});

describe("Binance route alternatives", () => {
	function setup(
		options: {
			failSubmission?: boolean;
			rateLimited?: boolean;
			budget?: RequestBudget;
			nativeSellValue?: bigint;
		} = {},
	) {
		const quotes = ["long", "third", "broken", "short", "second", "duplicate", "below-limit"];
		const getQuotes = vi.fn(async () =>
			quotes.map((quoteId) => ({
				quoteId,
				approveTarget: factory,
			})),
		);
		const data: Record<string, `0x${string}`> = {
			long: "0x11111111",
			third: "0x333333",
			short: "0x11",
			second: "0x2222",
			duplicate: "0x11",
			"below-limit": "0x",
		};
		const buildSwap = vi.fn(async (quoteId: string) => {
			if (quoteId === "broken") throw new Error("vendor unavailable");
			return {
				from: trampolineAddress,
				to: factory,
				data: data[quoteId],
				value: "0",
				minReceiveAmount: quoteId === "below-limit" ? "80" : "110",
			};
		});
		let submissionCount = 0;
		const submit = vi.fn<ByosClient["submit"]>(async () => {
			submissionCount++;
			if (options.rateLimited) throw new ByosRateLimitError(60_000);
			if (options.failSubmission && submissionCount === 1) throw new Error("SimFailed");
			return submissionCount;
		});
		const solver = new BinanceSubsolver(
			config,
			{
				solvableOrders: async () => [
					{ ...order(1), nativeSellValue: options.nativeSellValue ?? 10n ** 18n + 1n },
				],
			},
			{ proposals: async () => [], isTerminal: () => false, submit } as unknown as ByosClient,
			{ getQuotes, buildSwap } as unknown as BinanceClient,
			trampolineAddress,
			byosDomain(56, factory),
			async () => "0x",
			logger,
			options.budget ?? new RequestBudget(),
			new OrderFilter({ closeToExecutionTopN: 20 }),
		);
		return { solver, submit };
	}

	it("submits three distinct viable routes with the shortest calldata, despite a failed build", async () => {
		const { solver, submit } = setup();
		await solver.pollOnce(100n);
		expect(submit.mock.calls.map(([p]) => p.interactions[1]?.callData)).toEqual([
			"0x11",
			"0x2222",
			"0x333333",
		]);
		expect(new Set(submit.mock.calls.map(([p]) => p.nonce)).size).toBe(3);
		expect(submit.mock.calls.every(([p]) => p.orderUid === order(1).uid)).toBe(true);
		await solver.pollOnce(101n);
		expect(submit).toHaveBeenCalledTimes(3);
	});

	it.each([0n, 10n ** 18n - 1n, 10n ** 18n])(
		"submits only the shortest-calldata route for native sell value %s",
		async (nativeSellValue) => {
			const { solver, submit } = setup({ nativeSellValue });
			await solver.pollOnce(100n);
			expect(submit.mock.calls.map(([proposal]) => proposal.interactions[1]?.callData)).toEqual([
				"0x11",
			]);
		},
	);

	it("still submits siblings after one proposal fails BYOS simulation", async () => {
		const { solver, submit } = setup({ failSubmission: true });
		await solver.pollOnce(100n);
		expect(submit).toHaveBeenCalledTimes(3);
	});

	it("stops sibling submissions on HTTP 429 and observes the retry window", async () => {
		const { solver, submit } = setup({ rateLimited: true });
		await solver.pollOnce(100n);
		expect(submit).toHaveBeenCalledTimes(3);
		await solver.pollOnce(101n);
		expect(submit).toHaveBeenCalledTimes(3);
	});

	it("charges the submission budget for each alternative", async () => {
		const { solver, submit } = setup({ budget: new RequestBudget(4, 1) });
		await solver.pollOnce(100n);
		expect(submit).toHaveBeenCalledTimes(2);
	});
});

describe("auction pipeline scheduling", () => {
	it("submits a ready order without waiting for another order's quote", async () => {
		let release = () => {};
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		const submit = vi.fn<ByosClient["submit"]>(async () => 1);
		const getQuotes = vi.fn(async (_sell: string, _buy: string, amount: bigint) => {
			if (amount === 100n) await slow;
			return [{ quoteId: "route", approveTarget: factory }];
		});
		const solver = new BinanceSubsolver(
			{ ...config, binanceQuoteConcurrency: 2 },
			{
				solvableOrders: async () => [
					order(1),
					{ ...order(2), sellAmount: 101n, fullSellAmount: 101n },
				],
			},
			{ proposals: async () => [], isTerminal: () => false, submit } as unknown as ByosClient,
			{
				getQuotes,
				buildSwap: async () => ({ to: factory, data: "0x01", value: "0", minReceiveAmount: "110" }),
			} as unknown as BinanceClient,
			trampolineAddress,
			byosDomain(56, factory),
			async () => "0x",
			logger,
			new RequestBudget(),
			new OrderFilter({ closeToExecutionTopN: 20 }),
		);
		const cycle = solver.pollOnce(100n);
		try {
			await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1), { timeout: 500 });
			expect(submit.mock.calls[0]?.[0].orderUid).toBe(order(2).uid);
		} finally {
			release();
			await cycle;
		}
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
		return new BinanceSubsolver(
			{
				...config,
				binanceQuoteConcurrency: 8,
				byosSubmissionConcurrency: options.concurrency ?? 2,
			},
			{ solvableOrders: async () => orders },
			byos,
			{
				getQuotes: async (_sell: string, _buy: string, amount: bigint) => {
					if (options.slowQuote && amount === 100n) await options.slowQuote;
					return [{ quoteId: "route", approveTarget: factory }];
				},
				buildSwap: async () => ({ to: factory, data: "0x01", value: "0", minReceiveAmount: "110" }),
			} as unknown as BinanceClient,
			trampolineAddress,
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

describe("Binance build deadlines", () => {
	it("selects completed calldata without waiting indefinitely for a hanging vendor build", async () => {
		vi.useFakeTimers();
		const context = createAuctionWork({
			auctionId: "1",
			deadlineMs: Date.now() + 1500,
			receivedAtMs: Date.now(),
			deadlineBufferMs: 1000,
		});
		const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
			const id = new URL(String(input)).searchParams.get("quoteId");
			if (id === "slow")
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
						once: true,
					});
				});
			return Response.json({
				success: true,
				code: 0,
				data: id
					? { tx: { to: factory, data: "0x01", value: "0", minReceiveAmount: "110" } }
					: ["fast", "slow"].map((quoteId) => ({
							quoteId,
							approveTarget: factory,
							executionMode: "SWAP",
						})),
			});
		});
		vi.stubGlobal("fetch", fetch);
		const submit = vi.fn<ByosClient["submit"]>(async () => 1);
		const solver = new BinanceSubsolver(
			config,
			{ solvableOrders: async () => [{ ...order(1), nativeSellValue: 2n * 10n ** 18n }] },
			{ proposals: async () => [], isTerminal: () => false, submit } as unknown as ByosClient,
			new BinanceClient("key", "secret", 56),
			trampolineAddress,
			byosDomain(56, factory),
			async () => "0x",
			logger,
			new RequestBudget(),
			new OrderFilter({ closeToExecutionTopN: 20 }),
		);
		try {
			const cycle = solver.pollOnce(100n, context.work);
			await vi.advanceTimersByTimeAsync(401);
			await cycle;
			expect(submit).toHaveBeenCalledTimes(1);
			expect(fetch).toHaveBeenCalledTimes(3);
			expect(submit.mock.calls[0]?.[0].interactions[1]?.callData).toBe("0x01");
		} finally {
			context.abort();
			context.dispose();
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});
});
