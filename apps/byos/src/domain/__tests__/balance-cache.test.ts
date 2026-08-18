import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { unknownBalances } from "../balance-cache.js";

const SIGNER = "0x1111111111111111111111111111111111111111" as Address;

describe("unknownBalances stub", () => {
	it("knows nothing, so every signer is admitted at the lowest tier", async () => {
		await expect(unknownBalances.lookup(SIGNER)).resolves.toBe("unknown");
	});
});
