import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceClient } from "./binance-client.js";

const token = "0x0000000000000000000000000000000000000001" as const;

afterEach(() => vi.unstubAllGlobals());

describe("Binance slippage encoding", () => {
	it.each([
		[0, "0"],
		[5, "0.05"],
		[50, "0.5"],
	] as const)("encodes %i bps as %s percent in both requests", async (bps, percent) => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [] })))
			.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { tx: {} } })));
		vi.stubGlobal("fetch", fetchMock);
		const client = new BinanceClient("test-key", "test-secret", 56);
		await client.getQuotes(token, token, 100n, token, bps);
		await client.buildSwap("quote-1", token, token, 100n, token, bps);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const [url] of fetchMock.mock.calls) {
			expect(new URL(String(url)).searchParams.get("slippagePercent")).toBe(percent);
		}
	});
});
