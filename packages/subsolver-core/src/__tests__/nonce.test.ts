import { describe, expect, it } from "vitest";
import { randomNonce } from "../nonce.js";

describe("randomNonce", () => {
	it("generates distinct uint256 values", () => {
		const first = randomNonce();
		const second = randomNonce();
		expect(first).toBeGreaterThanOrEqual(0n);
		expect(first).toBeLessThan(1n << 256n);
		expect(second).not.toBe(first);
	});
});
