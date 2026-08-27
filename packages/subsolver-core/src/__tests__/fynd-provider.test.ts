import { describe, expect, it } from "vitest";
import { FyndProvider } from "../fynd-provider.js";

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
		expect(route?.interactions[0]?.target).toBe(router);
	});
});
