import { byosDomain } from "@byos/common";
import type { ByosClient, FyndProvider, OrderbookOrder } from "@byos/subsolver-core";
import { RequestBudget } from "@byos/subsolver-core";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { FyndSubsolver } from "./fynd-subsolver.js";

const factory = "0x0000000000000000000000000000000000000001" as const;
const logger = pino({ level: "silent" });

const config: Config = {
	orderBookUrl: "http://orderbook",
	byosUrl: "http://byos",
	rpcUrl: "http://rpc",
	privateKey: "0x01",
	logLevel: "silent",
	jsonLogs: true,
	fyndUrl: "http://fynd",
	fyndSlippageBps: 50,
	fyndQuoteConcurrency: 1,
	fyndMaxQuoteAgeSeconds: 10,
	gpv2Settlement: "0x0000000000000000000000000000000000000002",
	byosRequestsPerMinute: 100,
	byosReadReserve: 10,
	proposalRefreshIntervalSeconds: 15,
	toml: { chainId: 56, trampolineFactory: factory, proposalTtl: 60, pollInterval: 2 },
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
	);
}

describe("FyndSubsolver", () => {
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
