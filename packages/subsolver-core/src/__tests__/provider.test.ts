import { describe, expect, it, vi } from "vitest";
import { prioritizeCandidates } from "../polling.js";
import { type CandidateOrder, quoteBatch, type RouteProvider, streamQuotes } from "../provider.js";
import { SolveOrderbookClient } from "../solve-orderbook-client.js";

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
			[candidate("first"), candidate("empty"), candidate("error"), candidate("last")].map(
				(order) => ({ ...order, nativeSellValue: 10n ** 18n + 1n }),
			),
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

describe("native-value threshold from /solve", () => {
	it.each([
		{ amount: 999999n, price: "1000000000000000000000000000000", expected: 1 },
		{ amount: 1000000n, price: "1000000000000000000000000000000", expected: 1 },
		{ amount: 1000001n, price: "1000000000000000000000000000000", expected: 3 },
		{ amount: 10n ** 18n, price: "1000000000000000000", expected: 1 },
		{ amount: 10n ** 18n + 1n, price: "1000000000000000000", expected: 3 },
		{ amount: 10n ** 20n, price: null, expected: 1 },
	])(
		"submits $expected routes for $amount sell atoms at reference price $price",
		async ({ amount, price, expected }) => {
			const base = candidate("0x01");
			const client = new SolveOrderbookClient();
			client.receive({
				tokens: { [base.sellToken]: { referencePrice: price } },
				orders: [
					{
						uid: base.uid,
						sellToken: base.sellToken,
						buyToken: base.buyToken,
						sellAmount: amount.toString(),
						fullSellAmount: (amount * 10n).toString(),
						buyAmount: "1",
						fullBuyAmount: "10",
						kind: "sell",
						sellTokenSource: "erc20",
						buyTokenDestination: "erc20",
					},
				],
			});
			const orders = await client.solvableOrders();
			const candidates = prioritizeCandidates(
				orders.map((order) => ({
					...order,
					chainId: 56,
					executedSellAmount: order.fullSellAmount - order.sellAmount,
				})),
				() => false,
			).map(({ candidate }) => candidate);
			expect(candidates[0]?.remainingSell).toBe(amount);
			expect(candidates[0]?.nativeSellValue).toBe(
				price ? (amount * BigInt(price)) / 10n ** 18n : 0n,
			);
			const route = { quoteBuyAmount: 2n, minBuyAmount: 1n, interactions: [] };
			const quote = vi.fn(async () => route);
			const quoteMany = vi.fn(async () => [route, route, route]);
			expect(await quoteBatch({ name: "test", quote, quoteMany }, candidates)).toHaveLength(
				expected,
			);
			expect(quoteMany).toHaveBeenCalledTimes(expected === 3 ? 1 : 0);
			expect(quote).toHaveBeenCalledTimes(expected === 1 ? 1 : 0);
		},
	);

	it("defaults to one route when discovery has no native sell value", async () => {
		const route = { quoteBuyAmount: 2n, minBuyAmount: 1n, interactions: [] };
		const quoteMany = vi.fn(async () => [route, route, route]);
		expect(
			await quoteBatch({ name: "test", quote: async () => route, quoteMany }, [
				candidate("unpriced"),
			]),
		).toHaveLength(1);
		expect(quoteMany).not.toHaveBeenCalled();
	});
});

describe("streamQuotes", () => {
	it("hands over each order's result before slower orders finish", async () => {
		let release: () => void = () => {};
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		const provider: RouteProvider = {
			name: "test",
			quote: async (order) => {
				if (order.uid === "0x02") await slow;
				return { quoteBuyAmount: 2n, minBuyAmount: 1n, interactions: [] };
			},
		};
		const seen: string[] = [];
		const done = streamQuotes(
			provider,
			[candidate("0x01"), candidate("0x02")],
			async (result) => {
				seen.push(result.order.uid);
			},
			2,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(seen).toEqual(["0x01"]);
		release();
		await done;
		expect(seen).toEqual(["0x01", "0x02"]);
	});
});
