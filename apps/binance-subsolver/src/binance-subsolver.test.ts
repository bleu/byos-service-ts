import { byosDomain } from "@byos/common";
import type { ByosClient, OrderbookOrder } from "@byos/subsolver-core";
import { RequestBudget } from "@byos/subsolver-core";
import pino from "pino";
import { type Address, maxUint256 } from "viem";
import type { PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCache } from "./approval-cache.js";
import type { BinanceClient } from "./binance-client.js";
import { BinanceSubsolver } from "./binance-subsolver.js";
import type { Config } from "./config.js";

const factory = "0x0000000000000000000000000000000000000001" as const;
const trampolineAddress = "0x0000000000000000000000000000000000000005" as const;
const router = "0x0000000000000000000000000000000000000006" as const;
const logger = pino({ level: "silent" });

const config: Config = {
	orderBookUrl: "http://orderbook",
	byosUrl: "http://byos",
	rpcUrl: "http://rpc",
	privateKey: "0x01",
	logLevel: "silent",
	jsonLogs: true,
	chainId: 56,
	trampolineFactory: factory,
	binanceApiKey: "key",
	binanceSecretKey: "secret",
	binanceRouter: router,
	binanceSlippageBps: 50,
	binanceQuoteConcurrency: 1,
	byosRequestsPerMinute: 100,
	byosReadReserve: 10,
	proposalRefreshIntervalSeconds: 15,
	proposalTtlSeconds: 60,
	pollIntervalSeconds: 2,
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
	};
}

function subsolver(
	proposals: ReturnType<typeof vi.fn>,
	orders: readonly OrderbookOrder[],
	publicClient: PublicClient = { readContract: vi.fn(async () => maxUint256) } as unknown as PublicClient,
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
		new ApprovalCache(),
		publicClient,
		byosDomain(56, factory),
		async () => "0x" as `0x${string}`,
		logger,
		new RequestBudget(),
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

	it("skips the approve interaction when the token is already approved above maxUint256/2", async () => {
		const cache = new ApprovalCache();
		const alreadyApprovedToken = "0x0000000000000000000000000000000000000003" as Address;
		const readContract = vi.fn(async () => maxUint256);
		const publicClientMock = { readContract } as unknown as PublicClient;

		const needsApprove = await cache.needsApproval(
			alreadyApprovedToken,
			trampolineAddress,
			router,
			publicClientMock,
		);

		expect(needsApprove).toBe(false);
		expect(readContract).toHaveBeenCalledOnce();

		// Second call must use cache, not re-read
		const needsApprove2 = await cache.needsApproval(
			alreadyApprovedToken,
			trampolineAddress,
			router,
			publicClientMock,
		);
		expect(needsApprove2).toBe(false);
		expect(readContract).toHaveBeenCalledOnce();
	});

	it("requires an approve interaction when allowance is at or below maxUint256/2", async () => {
		const cache = new ApprovalCache();
		const unapprovedToken = "0x0000000000000000000000000000000000000003" as Address;
		const readContract = vi.fn(async () => maxUint256 / 2n);
		const publicClientMock = { readContract } as unknown as PublicClient;

		const needsApprove = await cache.needsApproval(
			unapprovedToken,
			trampolineAddress,
			router,
			publicClientMock,
		);

		expect(needsApprove).toBe(true);
		// Should re-check on every call since it was never cached
		const needsApprove2 = await cache.needsApproval(
			unapprovedToken,
			trampolineAddress,
			router,
			publicClientMock,
		);
		expect(needsApprove2).toBe(true);
		expect(readContract).toHaveBeenCalledTimes(2);
	});
});
