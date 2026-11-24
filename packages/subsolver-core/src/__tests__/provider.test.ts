import { describe, expect, it } from "vitest";
import { type CandidateOrder, quoteBatch, type RouteProvider } from "../provider.js";

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

describe("alternative route quoting", () => {
	it("keeps alternatives together, handles empty results, and isolates order errors", async () => {
		const route = { quoteBuyAmount: 2n, minBuyAmount: 1n, interactions: [] };
		const results = await quoteBatch(
			{
				name: "alternatives",
				quote: async () => {
					throw new Error("single-route API must not be used");
				},
				quoteMany: async (order) => {
					if (order.uid === "empty") return [];
					if (order.uid === "error") throw new Error("failed");
					return [route, { ...route, quoteBuyAmount: 3n }];
				},
			},
			[candidate("first"), candidate("empty"), candidate("error"), candidate("last")],
			2,
		);
		expect(results.map(({ order, route }) => [order.uid, route?.quoteBuyAmount])).toEqual([
			["first", 2n],
			["first", 3n],
			["empty", undefined],
			["error", undefined],
			["last", 2n],
			["last", 3n],
		]);
		expect(results[3]?.error).toBeInstanceOf(Error);
	});
});
