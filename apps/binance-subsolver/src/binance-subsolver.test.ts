import { byosDomain } from "@byos/common";
import type { ByosClient, OrderbookOrder } from "@byos/subsolver-core";
import { OrderFilter, RequestBudget } from "@byos/subsolver-core";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BinanceClient } from "./binance-client.js";
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
				expect(getQuotes).toHaveBeenCalledWith(usdt, buyToken, 100n, trampolineAddress, bps);
				for (const quote of quotes) {
					expect(buildSwap).toHaveBeenCalledWith(
						quote.quoteId,
						usdt,
						buyToken,
						100n,
						trampolineAddress,
						bps,
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
