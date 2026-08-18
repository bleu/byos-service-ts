import { describe, expect, it } from "vitest";
import { bufferDebit, nonSettlementDebit, revertDebit } from "../penalty.js";

describe("penalty", () => {
	it("revert debit is settlement cost plus c_l", () => {
		expect(revertDebit(50_000n, 10_000_000_000_000_000n)).toBe(10_000_000_000_050_000n);
	});

	it("non-settlement debit is 0.1 × c_l", () => {
		expect(nonSettlementDebit(10_000_000_000_000_000n)).toBe(1_000_000_000_000_000n);
	});

	it("non-settlement debit truncates (floor div)", () => {
		// 15 / 10 = 1 (not 1.5)
		expect(nonSettlementDebit(15n)).toBe(1n);
	});

	it("buffer debit converts gap to ETH via ref price", () => {
		const gap = 1_000_000n; // 1M buy-token atoms
		const refPrice = 500_000_000_000_000_000n; // 0.5 ETH per token unit
		expect(bufferDebit(gap, refPrice)).toBe(500_000n);
	});

	it("buffer debit is zero when gap is zero", () => {
		expect(bufferDebit(0n, 1_000_000_000_000_000_000n)).toBe(0n);
	});
});
