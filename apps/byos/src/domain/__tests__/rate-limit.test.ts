import { describe, expect, it } from "vitest";
import { allowAll, rateForBalance, slidingCount, type TierParams } from "../rate-limit.js";

const ETHER = 10n ** 18n;

/** 0.1 ETH buys 300 requests per window, floored at 120, ceilinged at 3000. */
const TIER: TierParams = {
	rateUnitWei: ETHER / 10n,
	ratePerUnit: 300,
	minRate: 120,
	maxRate: 3000,
};

describe("escrow rate tier", () => {
	it("an unfunded signer gets the minimum rate", () => {
		expect(rateForBalance(0n, TIER)).toBe(120);
	});

	it("one escrow unit buys one unit of throughput", () => {
		expect(rateForBalance(ETHER / 10n, TIER)).toBe(300);
	});

	it("a part-filled unit does not count", () => {
		// 0.19 ETH is one unit and change; the change buys nothing.
		expect(rateForBalance((ETHER * 19n) / 100n, TIER)).toBe(300);
	});

	it("a balance below the floor's worth still gets the minimum", () => {
		// 0.3 ETH earns 900, but 0.03 ETH earns 0 — the floor carries it.
		expect(rateForBalance((ETHER * 3n) / 100n, TIER)).toBe(120);
		expect(rateForBalance((ETHER * 3n) / 10n, TIER)).toBe(900);
	});

	it("a whale is capped, so it cannot starve everyone else", () => {
		expect(rateForBalance(ETHER * 10_000n, TIER)).toBe(3000);
	});
});

describe("sliding window count", () => {
	it("at the start of a window the previous window still counts in full", () => {
		expect(slidingCount(100, 0, 0)).toBe(100);
	});

	it("the previous window decays as the current one advances", () => {
		expect(slidingCount(100, 0, 0.25)).toBe(75);
		expect(slidingCount(100, 0, 0.5)).toBe(50);
		expect(slidingCount(100, 0, 0.9)).toBeCloseTo(10);
	});

	it("the current window counts in full regardless of position", () => {
		expect(slidingCount(0, 40, 0)).toBe(40);
		expect(slidingCount(0, 40, 0.75)).toBe(40);
	});

	it("a signer at the limit regains budget as the window slides", () => {
		// Spent the whole 120 budget last window, nothing this one.
		expect(slidingCount(120, 0, 0.5)).toBe(60);
		expect(slidingCount(120, 0, 0.99)).toBeCloseTo(1.2);
	});
});

describe("allowAll limiter", () => {
	it("always allows, so tests and local dev need no Redis", async () => {
		const decision = await allowAll.checkLimit("signer:0xabc", 1, 60);
		expect(decision.allowed).toBe(true);
	});
});
