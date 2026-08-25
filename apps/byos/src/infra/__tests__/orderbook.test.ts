import { OrderKind, SigningScheme } from "@byos/common";
import { OrderBookApiError, SupportedChainId } from "@cowprotocol/cow-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyOrderbookError, OrderbookClient } from "../orderbook.js";

// ---------------------------------------------------------------------------
// classifyOrderbookError — unit tests (no network)
// ---------------------------------------------------------------------------

function makeApiError(status: number): OrderBookApiError {
	const response = new Response("", { status });
	return new OrderBookApiError(response, null);
}

describe("classifyOrderbookError", () => {
	it("404 → notFound", () => {
		expect(classifyOrderbookError(makeApiError(404), "test")).toEqual({ kind: "notFound" });
	});

	it("5xx → transient", () => {
		expect(classifyOrderbookError(makeApiError(500), "test")).toEqual({
			kind: "transient",
			message: "test 500: server error",
		});
		expect(classifyOrderbookError(makeApiError(503), "test")).toEqual({
			kind: "transient",
			message: "test 503: server error",
		});
	});

	it("4xx non-404 → notFound (terminal)", () => {
		expect(classifyOrderbookError(makeApiError(400), "test")).toEqual({ kind: "notFound" });
		expect(classifyOrderbookError(makeApiError(422), "test")).toEqual({ kind: "notFound" });
	});

	it("network-level error (TypeError) → transient", () => {
		const err = new TypeError("fetch failed");
		const result = classifyOrderbookError(err, "orderbook");
		expect(result.kind).toBe("transient");
		if (result.kind === "transient") {
			expect(result.message).toContain("unreachable");
		}
	});

	it("generic error → transient", () => {
		const result = classifyOrderbookError(new Error("connection refused"), "orderbook");
		expect(result.kind).toBe("transient");
	});
});

// ---------------------------------------------------------------------------
// Helpers to construct minimal sdk-style order objects
// ---------------------------------------------------------------------------

const REAL_UID =
	"0xb9403b4c8342c3567e5b1928398030f010730c0b1d83657248e4e4e47984d90bd2e80d60aff5377587e49ff32c9bad639d6f68bc6a678be0";

function fakeOrder(overrides?: Record<string, unknown>): Record<string, unknown> {
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
		status: "open",
		creationDate: "2025-01-01T00:00:00.000Z",
		class: "market",
		executedSellAmount: "0",
		executedSellAmountBeforeFees: "0",
		executedBuyAmount: "0",
		executedFeeAmount: "0",
		invalidated: false,
		settlementContract: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
		totalFee: "0",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// OrderbookClient — uses vi.mock to stub OrderBookApi
// ---------------------------------------------------------------------------

// We mock the entire module so `new OrderBookApi(...)` returns our spy
vi.mock("@cowprotocol/cow-sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cowprotocol/cow-sdk")>();
	return {
		...actual,
		OrderBookApi: vi.fn(),
	};
});

import { OrderBookApi } from "@cowprotocol/cow-sdk";

function makeApiMock(overrides?: {
	getOrder?: ReturnType<typeof vi.fn>;
	getNativePrice?: ReturnType<typeof vi.fn>;
}) {
	const mock = {
		getOrder: overrides?.getOrder ?? vi.fn().mockResolvedValue(fakeOrder()),
		getNativePrice: overrides?.getNativePrice ?? vi.fn().mockResolvedValue({ price: 0.5 }),
	};
	vi.mocked(OrderBookApi).mockImplementation(() => mock as unknown as OrderBookApi);
	return mock;
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("OrderbookClient — order mapping", () => {
	it("maps kind and signing scheme correctly", async () => {
		makeApiMock({
			getOrder: vi.fn().mockResolvedValue(fakeOrder({ kind: "buy", signingScheme: "presign" })),
		});

		const record = await new OrderbookClient(SupportedChainId.MAINNET).order(REAL_UID);

		expect(record.order.kind).toBe(OrderKind.BUY);
		expect(record.order.signingScheme).toBe(SigningScheme.PreSign);
	});

	it("unknown kind throws transient instead of coercing", async () => {
		makeApiMock({ getOrder: vi.fn().mockResolvedValue(fakeOrder({ kind: "twap" })) });

		await expect(
			new OrderbookClient(SupportedChainId.MAINNET).order(REAL_UID),
		).rejects.toMatchObject({
			kind: "transient",
			message: "unknown order kind twap",
		});
	});

	it("unknown signing scheme throws transient", async () => {
		makeApiMock({ getOrder: vi.fn().mockResolvedValue(fakeOrder({ signingScheme: "eip191" })) });

		await expect(
			new OrderbookClient(SupportedChainId.MAINNET).order(REAL_UID),
		).rejects.toMatchObject({
			kind: "transient",
			message: "unknown signing scheme eip191",
		});
	});

	it("null receiver stays zero address", async () => {
		makeApiMock({ getOrder: vi.fn().mockResolvedValue(fakeOrder({ receiver: null })) });

		const record = await new OrderbookClient(SupportedChainId.MAINNET).order(REAL_UID);

		expect(record.order.receiver).toBe("0x0000000000000000000000000000000000000000");
	});

	it("parses a real order correctly", async () => {
		makeApiMock();

		const record = await new OrderbookClient(SupportedChainId.MAINNET).order(REAL_UID);

		expect(record.order.sellToken).toBe("0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1");
		expect(record.order.buyToken).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
		expect(record.order.receiver).toBe("0xd2e80d60aff5377587e49ff32c9bad639d6f68bc");
		expect(record.order.sellAmount).toBe(20_000_002_675_677_095_795n);
		expect(record.order.buyAmount).toBe(773_213_156n);
		expect(record.order.validTo).toBe(1_785_170_912);
		expect(record.order.kind).toBe(OrderKind.SELL);
		expect(record.order.partiallyFillable).toBe(false);
		expect(record.order.signingScheme).toBe(SigningScheme.Eip712);
		expect(record.order.signature).toHaveLength(132);
		expect(record.preInteractions).toEqual([]);
		expect(record.postInteractions).toEqual([]);
		expect(record.erc20Balances).toBe(true);
	});

	it("deserializes pre and post interactions", async () => {
		makeApiMock({
			getOrder: vi.fn().mockResolvedValue(
				fakeOrder({
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
				}),
			),
		});

		const record = await new OrderbookClient(SupportedChainId.MAINNET).order(REAL_UID);

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

describe("OrderbookClient — caching", () => {
	it("caches orders to avoid a second fetch", async () => {
		const getOrder = vi.fn().mockResolvedValue(fakeOrder());
		makeApiMock({ getOrder });

		const client = new OrderbookClient(SupportedChainId.MAINNET);
		await client.order(REAL_UID);
		await client.order(REAL_UID);

		expect(getOrder).toHaveBeenCalledTimes(1);
	});

	it("a failed fetch is not cached: subsequent call retries the network", async () => {
		// First call returns an invalid DTO (unknown kind → throws transient).
		// Second call returns a valid one. The cache must not be populated on failure.
		const invalidGetOrder = vi
			.fn()
			.mockResolvedValueOnce(fakeOrder({ kind: "twap" }))
			.mockResolvedValueOnce(fakeOrder());
		makeApiMock({ getOrder: invalidGetOrder });

		const client = new OrderbookClient(SupportedChainId.MAINNET);
		await expect(client.order(REAL_UID)).rejects.toMatchObject({ kind: "transient" });

		// Second call must re-fetch, not serve a cache entry
		const record = await client.order(REAL_UID);
		expect(record.order.kind).toBe(OrderKind.SELL);
		expect(invalidGetOrder).toHaveBeenCalledTimes(2);
	});

	it("cache clears instead of growing past its ceiling", async () => {
		const getOrder = vi.fn().mockResolvedValue(fakeOrder());
		makeApiMock({ getOrder });

		const client = new OrderbookClient(SupportedChainId.MAINNET, undefined, 2);
		const uid = (n: string) => `0x${n.repeat(56)}`;

		await client.order(uid("01"));
		await client.order(uid("02"));
		expect(getOrder).toHaveBeenCalledTimes(2);

		// Re-fetching a cached uid must not trip the clear
		await client.order(uid("01"));
		expect(getOrder).toHaveBeenCalledTimes(2);

		// The uid that trips the ceiling drops the rest
		await client.order(uid("03"));
		expect(getOrder).toHaveBeenCalledTimes(3);
		await client.order(uid("03"));
		expect(getOrder).toHaveBeenCalledTimes(3);

		// uid("01") was dropped by the clear
		await client.order(uid("01"));
		expect(getOrder).toHaveBeenCalledTimes(4);
	});
});

describe("OrderbookClient — error classification", () => {
	it("404 from getOrder → notFound", async () => {
		makeApiMock({ getOrder: vi.fn().mockRejectedValue(makeApiError(404)) });

		await expect(
			new OrderbookClient(SupportedChainId.MAINNET).order(REAL_UID),
		).rejects.toMatchObject({
			kind: "notFound",
		});
	});

	it("5xx from getOrder → transient", async () => {
		makeApiMock({ getOrder: vi.fn().mockRejectedValue(makeApiError(500)) });

		await expect(
			new OrderbookClient(SupportedChainId.MAINNET).order(REAL_UID),
		).rejects.toMatchObject({
			kind: "transient",
		});
	});

	it("network failure on getOrder → transient", async () => {
		makeApiMock({ getOrder: vi.fn().mockRejectedValue(new TypeError("fetch failed")) });

		await expect(
			new OrderbookClient(SupportedChainId.MAINNET).order(REAL_UID),
		).rejects.toMatchObject({
			kind: "transient",
		});
	});

	it("404 from getNativePrice → notFound", async () => {
		makeApiMock({ getNativePrice: vi.fn().mockRejectedValue(makeApiError(404)) });

		await expect(
			new OrderbookClient(SupportedChainId.MAINNET).nativePrice(
				"0x0000000000000000000000000000000000000000",
			),
		).rejects.toMatchObject({ kind: "notFound" });
	});

	it("5xx from getNativePrice → transient", async () => {
		makeApiMock({ getNativePrice: vi.fn().mockRejectedValue(makeApiError(503)) });

		await expect(
			new OrderbookClient(SupportedChainId.MAINNET).nativePrice(
				"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
			),
		).rejects.toMatchObject({ kind: "transient" });
	});
});

describe("OrderbookClient — native price", () => {
	it("converts price to reference semantics (×1e18)", async () => {
		makeApiMock({ getNativePrice: vi.fn().mockResolvedValue({ price: 0.5 }) });

		const price = await new OrderbookClient(SupportedChainId.MAINNET).nativePrice(
			"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
		);

		expect(price).toBe(500_000_000_000_000_000n);
	});

	it("undefined price → transient", async () => {
		makeApiMock({ getNativePrice: vi.fn().mockResolvedValue({}) });

		await expect(
			new OrderbookClient(SupportedChainId.MAINNET).nativePrice(
				"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
			),
		).rejects.toMatchObject({ kind: "transient", message: /unusable native price/ });
	});

	it("negative price → transient", async () => {
		makeApiMock({ getNativePrice: vi.fn().mockResolvedValue({ price: -1 }) });

		await expect(
			new OrderbookClient(SupportedChainId.MAINNET).nativePrice(
				"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
			),
		).rejects.toMatchObject({ kind: "transient", message: /unusable native price/ });
	});
});

describe("OrderbookClient — construction", () => {
	it("passes chainId to OrderBookApi", () => {
		makeApiMock();
		new OrderbookClient(SupportedChainId.GNOSIS_CHAIN);
		expect(vi.mocked(OrderBookApi)).toHaveBeenCalledWith({
			chainId: SupportedChainId.GNOSIS_CHAIN,
		});
	});

	it("passes baseUrl override as baseUrls record", () => {
		makeApiMock();
		new OrderbookClient(SupportedChainId.MAINNET, "http://barn.cow.fi/mainnet");
		expect(vi.mocked(OrderBookApi)).toHaveBeenCalledWith({
			chainId: SupportedChainId.MAINNET,
			baseUrls: { [SupportedChainId.MAINNET]: "http://barn.cow.fi/mainnet" },
		});
	});
});
