import { describe, expect, it } from "vitest";
import { BUY_ETH_ADDRESS } from "@byos/common";
import { FyndConfigurationError, FyndProvider } from "../fynd-provider.js";

const router = "0x0000000000000000000000000000000000000003" as const;
const client = {
	info: async () => ({ chainId: 56, routerAddress: router, permit2Address: router }),
	health: async () => ({ healthy: true, lastUpdateMs: 1, numSolverPools: 1 }),
	quote: async () => ({
		orderId: "quote-1",
		status: "success" as const,
		backend: "fynd" as const,
		amountIn: 100n,
		amountOut: 120n,
		gasEstimate: 1n,
		route: { swaps: [] },
		block: { number: 1, hash: "0x", timestamp: 100 },
		tokenOut: "0x0000000000000000000000000000000000000002" as const,
		receiver: "0x0000000000000000000000000000000000000004" as const,
		transaction: { to: router, value: 0n, data: "0xdead" as const },
		feeBreakdown: { routerFee: 0n, clientFee: 0n, maxSlippage: 0n, minAmountReceived: 110n },
	}),
};

describe("FyndProvider", () => {
	it("builds exact approval and router interactions for an eligible BSC sell order", async () => {
		const provider = new FyndProvider({
			client,
			chainId: 56,
			trampoline: "0x0000000000000000000000000000000000000005",
			settlement: "0x0000000000000000000000000000000000000004",
			now: () => 105,
		});
		const route = await provider.quote({
			uid: "0x01",
			chainId: 56,
			sellToken: "0x0000000000000000000000000000000000000001",
			buyToken: "0x0000000000000000000000000000000000000002",
			remainingSell: 100n,
			scaledLimitBuy: 100n,
		});
		expect(route?.minBuyAmount).toBe(110n);
		expect(route?.interactions).toHaveLength(2);
		expect(route?.interactions[0]?.target).toBe("0x0000000000000000000000000000000000000001");
		expect(route?.interactions[0]?.callData).toBe(
			"0x095ea7b300000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000064",
		);
	});

	it("skips native-token, same-token, and zero-size orders without calling Fynd", async () => {
		let calls = 0;
		const provider = new FyndProvider({
			client: { ...client, quote: async () => ((calls += 1), client.quote()) },
			chainId: 56,
			trampoline: "0x0000000000000000000000000000000000000005",
			settlement: "0x0000000000000000000000000000000000000004",
		});
		for (const [sellToken, buyToken, remainingSell] of [
			[BUY_ETH_ADDRESS, "0x0000000000000000000000000000000000000002", 100n],
			["0x0000000000000000000000000000000000000001", BUY_ETH_ADDRESS, 100n],
			[
				"0x0000000000000000000000000000000000000001",
				"0x0000000000000000000000000000000000000001",
				100n,
			],
			[
				"0x0000000000000000000000000000000000000001",
				"0x0000000000000000000000000000000000000002",
				0n,
			],
		] as const) {
			await expect(
				provider.quote({
					uid: "0x01",
					chainId: 56,
					sellToken,
					buyToken,
					remainingSell,
					scaledLimitBuy: 1n,
				}),
			).resolves.toBeNull();
		}
		expect(calls).toBe(0);
	});

	it("rejects stale, unsafe, and under-limit successful responses", async () => {
		const badQuote = {
			...client.quote,
		};
		const response = await client.quote();
		const variants = [
			{ ...response, block: { ...response.block, timestamp: 94 } },
			{ ...response, transaction: { ...response.transaction, value: 1n } },
			{ ...response, feeBreakdown: { ...response.feeBreakdown, minAmountReceived: 99n } },
			{ ...response, status: "not_ready" as const },
		];
		for (const quote of variants) {
			const provider = new FyndProvider({
				client: { ...client, quote: async () => quote },
				chainId: 56,
				trampoline: "0x0000000000000000000000000000000000000005",
				settlement: "0x0000000000000000000000000000000000000004",
				now: () => 105,
			});
			await expect(
				provider.quote({
					uid: "0x01",
					chainId: 56,
					sellToken: "0x0000000000000000000000000000000000000001",
					buyToken: "0x0000000000000000000000000000000000000002",
					remainingSell: 100n,
					scaledLimitBuy: 100n,
				}),
			).resolves.toBeNull();
		}
		expect(badQuote).toBeDefined();
	});

	it("fails fast when the sidecar reports the wrong chain or no router", async () => {
		const provider = new FyndProvider({
			client: {
				...client,
				info: async () => ({ chainId: 1, routerAddress: null, permit2Address: router }),
			},
			chainId: 56,
			trampoline: "0x0000000000000000000000000000000000000005",
			settlement: "0x0000000000000000000000000000000000000004",
		});
		await expect(provider.initialize()).rejects.toBeInstanceOf(FyndConfigurationError);
	});
});
