import { describe, expect, it } from "vitest";
import { OrderFilter } from "../order-filter.js";
import type { OrderbookOrder } from "../orderbook-client.js";

function order(index: number, value = 1n, kind: "sell" | "buy" = "sell"): OrderbookOrder {
	return {
		uid: `0x${index.toString(16).padStart(112, "0")}`,
		sellToken: "0x0000000000000000000000000000000000000001",
		buyToken: "0x0000000000000000000000000000000000000002",
		sellAmount: 100n,
		buyAmount: 90n,
		fullSellAmount: 100n,
		fullBuyAmount: 90n,
		kind,
		nativeBuyValue: value,
		nativeSellValue: 1n,
		estimatedNativeSurplus: 0n,
	};
}

describe("OrderFilter auction discovery", () => {
	it("uses top-N for the baseline and always includes newly arriving sell orders", () => {
		const filter = new OrderFilter({ closeToExecutionTopN: 1 });
		const top = order(1, 100n);
		const excluded = order(2);
		const fresh = order(3);
		expect(filter.filter([top, excluded])).toEqual([top]);
		expect(filter.filter([top, excluded, fresh])).toEqual([top, fresh]);
		expect(filter.filter([top, excluded, fresh])).toEqual([top]);
	});

	it("remembers all orders while keeping buy orders out of top-N", () => {
		const filter = new OrderFilter({ closeToExecutionTopN: 1 });
		const buy = order(1, 1n, "buy");
		const top = order(2, 100n);
		const excluded = order(3);
		expect(filter.filter([buy, top, excluded])).toEqual([top]);
		expect(filter.filter([{ ...buy, kind: "sell" }, top, excluded])).toEqual([top]);
	});

	it("compares UID case-insensitively", () => {
		const filter = new OrderFilter({ closeToExecutionTopN: 1 });
		const top = order(1, 100n);
		const excluded = order(10);
		filter.filter([top, excluded]);
		expect(
			filter.filter([
				top,
				{ ...excluded, uid: excluded.uid.toUpperCase().replace("0X", "0x") as `0x${string}` },
			]),
		).toEqual([top]);
	});

	it("updates the full baseline even for an empty auction and detects reappearing orders", () => {
		const filter = new OrderFilter({ closeToExecutionTopN: 1 });
		const orders = [order(1, 100n), order(2)];
		filter.filter(orders);
		expect(filter.filter([])).toEqual([]);
		expect(filter.filter(orders)).toEqual(orders);
	});
});
