import { afterEach, describe, expect, it, vi } from "vitest";
import { ByosClient, OrderbookClient } from "../index.js";

afterEach(() => vi.unstubAllGlobals());

describe("shared API clients", () => {
	it("normalizes eligible orderbook orders and preserves full amounts", async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					tokens: {
						"0x0000000000000000000000000000000000000001": {
							referencePrice: "1000000000000000000",
						},
						"0x0000000000000000000000000000000000000002": {
							referencePrice: "2000000000000000000",
						},
					},
					orders: [
						{
							uid: "0x01",
							sellToken: "0x0000000000000000000000000000000000000001",
							buyToken: "0x0000000000000000000000000000000000000002",
							sellAmount: "67",
							buyAmount: "68",
							fullSellAmount: "100",
							fullBuyAmount: "101",
							kind: "sell",
							sellTokenBalance: "erc20",
							buyTokenBalance: "erc20",
						},
						{
							uid: "0x02",
							sellToken: "0x0000000000000000000000000000000000000001",
							buyToken: "0x0000000000000000000000000000000000000002",
							sellAmount: "1",
							buyAmount: "1",
							kind: "sell",
							sellTokenBalance: "external",
							buyTokenBalance: "erc20",
						},
					],
				}),
			),
		);
		vi.stubGlobal("fetch", fetch);

		const orders = await new OrderbookClient("http://orderbook/").solvableOrders();

		expect(fetch).toHaveBeenCalledWith("http://orderbook/api/v1/auction");
		expect(orders).toEqual([
			expect.objectContaining({
				sellAmount: 67n,
				buyAmount: 68n,
				fullSellAmount: 100n,
				fullBuyAmount: 101n,
				estimatedNativeSurplus: 69n,
			}),
		]);
	});

	it("serializes and submits a signed proposal through BYOS", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ id: 7 }), { status: 202 }));
		vi.stubGlobal("fetch", fetch);
		const client = new ByosClient("http://byos/", { chainId: 56 }, vi.fn());

		await expect(
			client.submit({
				orderUid: "0x01",
				sellToken: "0x0000000000000000000000000000000000000001",
				buyToken: "0x0000000000000000000000000000000000000002",
				sellAmount: 10n,
				minBuyAmount: 9n,
				quoteBuyAmount: 11n,
				interactions: [],
				validUntil: 60n,
				nonce: 1n,
				signature: "0x01",
			}),
		).resolves.toBe(7);
		expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({
			sellAmount: "10",
			minBuyAmount: "9",
			nonce: "1",
		});
	});
});
