import { describe, expect, it } from "vitest";
import { perProposalCL } from "../collateral.js";

const SCALE = 10n ** 18n;

describe("deployment penalty cap", () => {
	it("scales sell volume below the absolute cap and binds at the cap", () => {
		expect(perProposalCL(SCALE.toString(), SCALE.toString(), 4n, SCALE)).toBe(400_000_000_000_000n);
		expect(perProposalCL((100n * SCALE).toString(), SCALE.toString(), 4n, SCALE / 100n)).toBe(
			SCALE / 100n,
		);
	});
	it("values token atoms without assuming token decimals", () => {
		expect(perProposalCL("2000000", (5n * 10n ** 29n).toString(), 4n, SCALE)).toBe(
			(SCALE * 4n) / 10_000n,
		);
	});
	it("rounds down, retains bigint precision, and handles zero configuration", () => {
		expect(perProposalCL("2499", SCALE.toString(), 4n, SCALE)).toBe(0n);
		expect(perProposalCL((2n ** 256n - 1n).toString(), SCALE.toString(), 4n, SCALE)).toBe(SCALE);
		expect(perProposalCL(SCALE.toString(), SCALE.toString(), 0n, SCALE)).toBe(0n);
		expect(perProposalCL(SCALE.toString(), SCALE.toString(), 4n, 0n)).toBe(0n);
	});
	it.each([null, "0"])("reserves the absolute cap when legacy price is %s", (price) => {
		expect(perProposalCL("1", price, 4n, 100n)).toBe(100n);
	});
});
