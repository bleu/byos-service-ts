import { OrderKind, SigningScheme } from "@byos/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrderbookClient } from "../orderbook.js";

const UID = `0x${"ab".repeat(56)}`;

function orderDto(overrides?: Record<string, unknown>): Record<string, unknown> {
	return {
		receiver: null,
		sellToken: "0xB1F1ee126e9c96231Cc3d3fAD7C08b4cf873b1f1",
		buyToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		sellAmount: "1000000",
		buyAmount: "990000",
		feeAmount: "0",
		validTo: 1_700_000_000,
		appData: `0x${"00".repeat(32)}`,
		kind: "sell",
		partiallyFillable: false,
		sellTokenBalance: "erc20",
		buyTokenBalance: "erc20",
		signingScheme: "eip712",
		signature: `0x${"ab".repeat(65)}`,
		...overrides,
	};
}

function stubFetchWith(body: Record<string, unknown>): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
	);
}

/**
 * The real mainnet order 0xb9403b4c... as returned by the orderbook (fetched
 * 2026-07-27 for the Rust fixture), trimmed to the fields the client reads.
 */
const REAL_UID =
	"0xb9403b4c8342c3567e5b1928398030f010730c0b1d83657248e4e4e47984d90bd2e80d60aff5377587e49ff32c9bad639d6f68bc6a678be0";

function realOrderJson(): Record<string, unknown> {
	return {
		uid: REAL_UID,
		owner: "0xd2e80d60aff5377587e49ff32c9bad639d6f68bc",
		receiver: "0xd2e80d60aff5377587e49ff32c9bad639d6f68bc",
		sellToken: "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1",
		buyToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
		sellAmount: "20000002675677095795",
		buyAmount: "773213156",
		feeAmount: "0",
		validTo: 1785170912,
		appData: "0x06ebf0fd49ea441fbd174e445f37f792eb8ee8848c66c470f59d06a1c3e318a4",
		kind: "sell",
		partiallyFillable: false,
		sellTokenBalance: "erc20",
		buyTokenBalance: "erc20",
		signingScheme: "eip712",
		signature:
			"0x45bcd35b2abeeafca8cd2ea00bd662ab327e0ffd7cd38319eeff8432fd49409f6e56384a88dcdc050d92b389285c3cfd78c903f3a20f64641b9f907dbf9de8b71c",
		fullAppData:
			'{"appCode":"1inch CoW Swap","metadata":{"orderClass":{"orderClass":"market"},"quote":{"slippageBips":56}},"version":"1.4.0"}',
		status: "open",
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("orderbook DTO enum mapping", () => {
	it("maps known kind and signing scheme", async () => {
		stubFetchWith(orderDto({ kind: "buy", signingScheme: "presign" }));

		const record = await new OrderbookClient("http://orderbook.test").order(UID);

		expect(record.order.kind).toBe(OrderKind.BUY);
		expect(record.order.signingScheme).toBe(SigningScheme.PreSign);
	});

	it("unknown kind throws transient instead of coercing to sell", async () => {
		stubFetchWith(orderDto({ kind: "twap" }));

		await expect(new OrderbookClient("http://orderbook.test").order(UID)).rejects.toMatchObject({
			kind: "transient",
			message: "unknown order kind twap",
		});
	});

	it("unknown signing scheme throws transient instead of coercing to eip712", async () => {
		stubFetchWith(orderDto({ signingScheme: "eip191" }));

		await expect(new OrderbookClient("http://orderbook.test").order(UID)).rejects.toMatchObject({
			kind: "transient",
			message: "unknown signing scheme eip191",
		});
	});

	it("a rejected order is not cached", async () => {
		const client = new OrderbookClient("http://orderbook.test");
		stubFetchWith(orderDto({ kind: "twap" }));
		await expect(client.order(UID)).rejects.toMatchObject({ kind: "transient" });

		// Same uid, now with a valid payload: must refetch, not serve a cache entry.
		stubFetchWith(orderDto());
		const record = await client.order(UID);
		expect(record.order.kind).toBe(OrderKind.SELL);
	});
});

describe("OrderbookClient", () => {
	it("fetches and parses a real order", async () => {
		stubFetchWith(realOrderJson());

		const record = await new OrderbookClient("http://orderbook.test").order(REAL_UID);

		expect(record.order.sellToken).toBe("0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1");
		expect(record.order.buyToken).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
		expect(record.order.receiver).toBe("0xd2e80d60aff5377587e49ff32c9bad639d6f68bc");
		expect(record.order.sellAmount).toBe(20_000_002_675_677_095_795n);
		expect(record.order.buyAmount).toBe(773_213_156n);
		expect(record.order.validTo).toBe(1_785_170_912);
		expect(record.order.appData).toBe(
			"0x06ebf0fd49ea441fbd174e445f37f792eb8ee8848c66c470f59d06a1c3e318a4",
		);
		expect(record.order.kind).toBe(OrderKind.SELL);
		expect(record.order.partiallyFillable).toBe(false);
		expect(record.order.signingScheme).toBe(SigningScheme.Eip712);
		// 65-byte ECDSA signature: 0x + 130 hex chars.
		expect(record.order.signature).toHaveLength(132);
		expect(record.preInteractions).toEqual([]);
		expect(record.postInteractions).toEqual([]);
		expect(record.erc20Balances).toBe(true);
	});

	it("base url path prefix is preserved", async () => {
		// Production base URLs carry a network segment
		// (https://api.cow.fi/mainnet); it must survive URL construction.
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify(realOrderJson()), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		await new OrderbookClient("http://orderbook.test/mainnet").order(REAL_UID);

		expect(fetchMock).toHaveBeenCalledWith(
			`http://orderbook.test/mainnet/api/v1/orders/${REAL_UID}`,
		);
	});

	it("null receiver stays zero", async () => {
		// receiver is part of the signed order struct; a null ("same as
		// owner") must reach the trade encoding as the zero address, not be
		// rewritten to the owner.
		stubFetchWith({ ...realOrderJson(), receiver: null });

		const record = await new OrderbookClient("http://orderbook.test").order(REAL_UID);

		expect(record.order.receiver).toBe("0x0000000000000000000000000000000000000000");
	});

	it("cache clears instead of growing past its ceiling", async () => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify(realOrderJson()), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new OrderbookClient("http://orderbook.test", 2);
		const uid = (n: string) => `0x${n.repeat(56)}`;

		await client.order(uid("01"));
		await client.order(uid("02"));
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// Re-fetching a cached uid is a hit and must not trip the clear.
		await client.order(uid("01"));
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// The uid that trips the ceiling drops the rest and is kept itself, so
		// the caller that just paid for a fetch still gets a hit.
		await client.order(uid("03"));
		expect(fetchMock).toHaveBeenCalledTimes(3);
		await client.order(uid("03"));
		expect(fetchMock).toHaveBeenCalledTimes(3);

		// uid 01 was dropped by the clear: fetching it again hits the network.
		await client.order(uid("01"));
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("caches orders to avoid a second fetch", async () => {
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				calls += 1;
				if (calls > 1) throw new Error("a second HTTP hit fails the test");
				return new Response(JSON.stringify(realOrderJson()), { status: 200 });
			}),
		);
		const client = new OrderbookClient("http://orderbook.test");

		await client.order(REAL_UID);
		const cached = await client.order(REAL_UID);

		expect(cached.order.sellAmount).toBe(20_000_002_675_677_095_795n);
	});

	it("native price converts to reference semantics", async () => {
		// The endpoint answers native atoms per token atom; the client
		// returns wei per 10^18 atoms (auction reference price).
		stubFetchWith({ price: 0.5 });

		const price = await new OrderbookClient("http://orderbook.test").nativePrice(
			"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
		);

		expect(price).toBe(500_000_000_000_000_000n);
	});

	it("unknown token price is not found", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 404 })),
		);

		await expect(
			new OrderbookClient("http://orderbook.test").nativePrice(
				"0x0000000000000000000000000000000000000000",
			),
		).rejects.toMatchObject({ kind: "notFound" });
	});

	it("unknown order is not found", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 404 })),
		);

		await expect(
			new OrderbookClient("http://orderbook.test").order(REAL_UID),
		).rejects.toMatchObject({ kind: "notFound" });
	});

	it("unreachable orderbook is transient", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);

		await expect(
			new OrderbookClient("http://orderbook.test").order(REAL_UID),
		).rejects.toMatchObject({ kind: "transient" });
	});

	it("order interactions are deserialized from the api", async () => {
		stubFetchWith({
			...realOrderJson(),
			interactions: {
				pre: [
					{
						target: "0x0000000000000000000000000000000000005678",
						value: "0",
						callData: "0xabcd",
					},
				],
				post: [],
			},
		});

		const record = await new OrderbookClient("http://orderbook.test").order(REAL_UID);

		expect(record.preInteractions).toEqual([
			{
				target: "0x0000000000000000000000000000000000005678",
				value: 0n,
				callData: "0xabcd",
			},
		]);
		expect(record.postInteractions).toEqual([]);
	});
});
