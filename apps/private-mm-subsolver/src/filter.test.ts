import type { OrderbookOrder } from "@byos/subsolver-core";
import { describe, expect, it } from "vitest";
import { filterCandidates } from "./filter.js";

// Addresses matching the real USDC/USDT on mainnet — lowercased in assertions
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as const;
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7" as const;
const OTHER = "0x6b175474e89094c44da98b954eedeac495271d0f" as const; // DAI

const TRAMPOLINE_BALANCE = 50_000_000n; // 50 USDC / 50 USDT (6 decimals)

const trampolineBalance = new Map([
	[USDC.toLowerCase(), TRAMPOLINE_BALANCE],
	[USDT.toLowerCase(), TRAMPOLINE_BALANCE],
]);

const filterConfig = {
	usdcAddress: USDC,
	usdtAddress: USDT,
	trampolineBalance,
	trackedUids: new Set<string>(),
};

function makeOrder(overrides: Partial<OrderbookOrder> = {}): OrderbookOrder {
	return {
		uid: "0xaabbcc",
		sellToken: USDC,
		buyToken: USDT,
		sellAmount: 10_000_000n,
		buyAmount: 9_990_000n,
		kind: "sell",
		fullSellAmount: 10_000_000n,
		fullBuyAmount: 9_990_000n,
		estimatedNativeSurplus: 0n,
		...overrides,
	};
}

describe("filterCandidates", () => {
	it("passes a valid USDC→USDT sell order", () => {
		const order = makeOrder();
		expect(filterCandidates([order], filterConfig)).toEqual([order]);
	});

	it("passes a valid USDT→USDC sell order", () => {
		const order = makeOrder({ sellToken: USDT, buyToken: USDC });
		expect(filterCandidates([order], filterConfig)).toEqual([order]);
	});

	it("rejects buy orders", () => {
		const order = makeOrder({ kind: "buy" });
		expect(filterCandidates([order], filterConfig)).toEqual([]);
	});

	it("rejects partial fill orders (sellAmount < fullSellAmount)", () => {
		const order = makeOrder({ sellAmount: 5_000_000n, fullSellAmount: 10_000_000n });
		expect(filterCandidates([order], filterConfig)).toEqual([]);
	});

	it("rejects orders where the sell token is not USDC or USDT", () => {
		const order = makeOrder({ sellToken: OTHER, buyToken: USDT });
		expect(filterCandidates([order], filterConfig)).toEqual([]);
	});

	it("rejects orders where the buy token is not USDC or USDT", () => {
		const order = makeOrder({ sellToken: USDC, buyToken: OTHER });
		expect(filterCandidates([order], filterConfig)).toEqual([]);
	});

	it("rejects orders where neither token is USDC or USDT", () => {
		const order = makeOrder({ sellToken: OTHER, buyToken: OTHER });
		expect(filterCandidates([order], filterConfig)).toEqual([]);
	});

	it("rejects orders where sellAmount exceeds the trampoline balance of buyToken", () => {
		const order = makeOrder({
			sellAmount: TRAMPOLINE_BALANCE + 1n,
			fullSellAmount: TRAMPOLINE_BALANCE + 1n,
		});
		expect(filterCandidates([order], filterConfig)).toEqual([]);
	});

	it("passes orders where sellAmount equals the trampoline balance exactly", () => {
		const order = makeOrder({ sellAmount: TRAMPOLINE_BALANCE, fullSellAmount: TRAMPOLINE_BALANCE });
		expect(filterCandidates([order], filterConfig)).toEqual([order]);
	});

	it("rejects orders already present in the tracked proposals cache", () => {
		const order = makeOrder({ uid: "0xdeadbeef" });
		const config = { ...filterConfig, trackedUids: new Set(["0xdeadbeef"]) };
		expect(filterCandidates([order], config)).toEqual([]);
	});

	it("is case-insensitive for orderUid tracking", () => {
		const order = makeOrder({ uid: "0xDEADBEEF" });
		const config = { ...filterConfig, trackedUids: new Set(["0xdeadbeef"]) };
		expect(filterCandidates([order], config)).toEqual([]);
	});

	it("returns only valid orders from a mixed batch", () => {
		const valid1 = makeOrder({ uid: "0x01", sellToken: USDC, buyToken: USDT });
		const valid2 = makeOrder({ uid: "0x02", sellToken: USDT, buyToken: USDC });
		const buyOrder = makeOrder({ uid: "0x03", kind: "buy" });
		const partialFill = makeOrder({
			uid: "0x04",
			sellAmount: 5_000_000n,
			fullSellAmount: 10_000_000n,
		});
		const wrongPair = makeOrder({ uid: "0x05", sellToken: OTHER, buyToken: USDT });
		const overBalance = makeOrder({
			uid: "0x06",
			sellAmount: TRAMPOLINE_BALANCE + 1n,
			fullSellAmount: TRAMPOLINE_BALANCE + 1n,
		});
		const tracked = makeOrder({ uid: "0x07" });
		const config = { ...filterConfig, trackedUids: new Set(["0x07"]) };

		const result = filterCandidates(
			[valid1, valid2, buyOrder, partialFill, wrongPair, overBalance, tracked],
			config,
		);

		expect(result).toEqual([valid1, valid2]);
	});
});
