import { describe, expect, it } from "vitest";
import { quoteBatch, type CandidateOrder, type RouteProvider } from "../provider.js";

const candidate = (uid: string): CandidateOrder => ({
	uid,
	chainId: 56,
	sellToken: "0x0000000000000000000000000000000000000001",
	buyToken: "0x0000000000000000000000000000000000000002",
	remainingSell: 1n,
	scaledLimitBuy: 1n,
});

describe("quoteBatch", () => {
	it("bounds parallel quotes and isolates individual errors", async () => {
		let active = 0;
		let maximum = 0;
		const provider: RouteProvider = {
			name: "test",
			quote: async (order) => {
				active += 1;
				maximum = Math.max(maximum, active);
				await Promise.resolve();
				active -= 1;
				if (order.uid === "0x02") throw new Error("bad order");
				return { quoteBuyAmount: 2n, minBuyAmount: 1n, interactions: [] };
			},
		};

		const results = await quoteBatch(
			provider,
			[candidate("0x01"), candidate("0x02"), candidate("0x03")],
			2,
		);

		expect(maximum).toBeLessThanOrEqual(2);
		expect(results.map((result) => result.route?.quoteBuyAmount ?? null)).toEqual([2n, null, 2n]);
		expect(results[1]?.error).toBeInstanceOf(Error);
	});
});
