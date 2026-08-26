import { describe, expect, it } from "vitest";
import type { RouteProvider } from "../provider.js";

describe("RouteProvider", () => {
	it("lets a provider skip an unquotable order without failing its batch", async () => {
		const provider: RouteProvider = {
			name: "fynd",
			quote: async () => null,
		};

		await expect(
			provider.quote({
				uid: "0x01",
				chainId: 56,
				sellToken: "0x0000000000000000000000000000000000000001",
				buyToken: "0x0000000000000000000000000000000000000002",
				remainingSell: 1n,
				scaledLimitBuy: 1n,
			}),
		).resolves.toBeNull();
	});
});
