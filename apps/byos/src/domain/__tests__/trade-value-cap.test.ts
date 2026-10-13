import { describe, expect, it } from "vitest";
import { checkTradeValueCap } from "../order.js";

const SCALE = 10n ** 18n;

describe("proposal native sell-value cap", () => {
	it("admits only values strictly below 10,000 times collateral", () => {
		const collateral = 10n ** 16n;
		const cap = 10_000n * collateral;
		expect(checkTradeValueCap(cap - 1n, SCALE, collateral)).toBeNull();
		expect(checkTradeValueCap(cap, SCALE, collateral)).toBe("TradeValueCapExceeded");
		expect(checkTradeValueCap(cap + 1n, SCALE, collateral)).toBe("TradeValueCapExceeded");
	});

	it("uses native price per token atom without token-decimal adjustments", () => {
		// A six-decimal token worth 0.5 native per token: two tokens = one native.
		const price = 5n * 10n ** 29n;
		const collateral = 10n ** 14n; // cap = one native
		expect(checkTradeValueCap(1_999_999n, price, collateral)).toBeNull();
		expect(checkTradeValueCap(2_000_000n, price, collateral)).toBe("TradeValueCapExceeded");
	});

	it("does not round fractional wei or lose precision for uint256 amounts", () => {
		expect(checkTradeValueCap(10_000n * SCALE - 1n, 1n, 1n)).toBeNull();
		expect(checkTradeValueCap(10_000n * SCALE, 1n, 1n)).toBe("TradeValueCapExceeded");
		expect(checkTradeValueCap(2n ** 256n - 1n, SCALE, 10n ** 16n)).toBe("TradeValueCapExceeded");
	});

	it("does not disable the cap when MIN_COLLATERAL is zero", () => {
		expect(checkTradeValueCap(1n, SCALE, 0n)).toBe("TradeValueCapExceeded");
	});
});
