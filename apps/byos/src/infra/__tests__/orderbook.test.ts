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
