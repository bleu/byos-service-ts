import { describe, expect, it } from "vitest";
import { amountIn, amountOut, pairAddress } from "../routing.js";

describe("Uniswap V2 routing", () => {
	describe("amountOut", () => {
		it("computes output with 0.3% fee", () => {
			// 1000 in, 10000/10000 reserves → 997 * 10000 / (10000 * 1000 + 997 * 1000) ≈ 906
			const out = amountOut(1000n, 10000n, 10000n);
			expect(out).toBe(906n);
		});

		it("returns null for zero reserves", () => {
			expect(amountOut(1000n, 0n, 10000n)).toBeNull();
			expect(amountOut(1000n, 10000n, 0n)).toBeNull();
		});

		it("returns null for zero input", () => {
			expect(amountOut(0n, 10000n, 10000n)).toBeNull();
		});

		it("handles large amounts", () => {
			const out = amountOut(10n ** 18n, 10n ** 24n, 10n ** 24n);
			expect(out).toBeGreaterThan(0n);
			expect(out).toBeLessThan(10n ** 18n); // output < input due to fee
		});
	});

	describe("amountIn", () => {
		it("computes input with 0.3% fee (ceil div)", () => {
			// How much input to get 906 output from 10000/10000 reserves?
			const input = amountIn(906n, 10000n, 10000n);
			expect(input).not.toBeNull();
			// Verify round-trip: amountOut(input, ...) >= 906
			const output = amountOut(input!, 10000n, 10000n);
			expect(output).not.toBeNull();
			expect(output!).toBeGreaterThanOrEqual(906n);
		});

		it("returns null when output exceeds reserve", () => {
			expect(amountIn(10001n, 10000n, 10000n)).toBeNull();
		});

		it("returns null for zero reserves", () => {
			expect(amountIn(1000n, 0n, 10000n)).toBeNull();
			expect(amountIn(1000n, 10000n, 0n)).toBeNull();
		});

		it("returns null for zero output", () => {
			expect(amountIn(0n, 10000n, 10000n)).toBeNull();
		});
	});

	describe("pairAddress", () => {
		it("is deterministic regardless of token order", () => {
			const factory = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
			const initCode = "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f";
			const tokenA = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
			const tokenB = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

			const addr1 = pairAddress(factory, initCode, tokenA, tokenB);
			const addr2 = pairAddress(factory, initCode, tokenB, tokenA);
			expect(addr1).toBe(addr2);
		});

		it("returns a valid address", () => {
			const addr = pairAddress(
				"0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
				"0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f",
				"0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
				"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
			);
			expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
		});
	});
});
