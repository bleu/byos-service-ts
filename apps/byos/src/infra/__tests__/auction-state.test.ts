import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { auctionOrderSchema } from "../api/types.js";
import { auctionOrderToRecord, createRedisAuctionStateBackend } from "../auction-state.js";
import { nativeBuyAuctionOrder } from "../blockchain/__tests__/fixtures/native-buy-order.js";

const hint = {
	liquidityProvider: "0x1111111111111111111111111111111111111111",
	protocolAdapter: "0x2222222222222222222222222222222222222222",
	receiver: "0x3333333333333333333333333333333333333333",
	token: "0x4444444444444444444444444444444444444444",
	amount: (2n ** 200n).toString(),
};

describe("auction settlement context", () => {
	it.each([undefined, null])("accepts an absent/null flash loan hint (%s)", (flashloanHint) => {
		const order = auctionOrderSchema.parse({ ...nativeBuyAuctionOrder, flashloanHint });
		expect(auctionOrderToRecord(order).flashloanHint).toBeUndefined();
	});
	it("round trips flash loan amounts and unsupported bundle detection through Redis JSON", async () => {
		const order = auctionOrderSchema.parse({
			...nativeBuyAuctionOrder,
			flashloanHint: hint,
			wrappers: [{ address: hint.receiver, data: "0x1234", isOmittable: false }],
		});
		const record = auctionOrderToRecord(order);
		expect(record.flashloanHint?.amount).toBe(2n ** 200n);
		expect(record.hasSettlementWrappers).toBe(true);
		let stored: string | null = null;
		const redis = {
			set: async (_key: string, data: string) => {
				stored = data;
			},
			get: async () => stored,
		} as unknown as Redis;
		const backend = createRedisAuctionStateBackend(redis);
		const state = {
			auctionId: 1,
			orders: new Map([[order.uid, record]]),
			prices: new Map([[hint.token, 1n]]),
			gasPrice: 2n,
		};
		await backend.set(state);
		expect(await backend.get()).toEqual(state);
	});
	it("retains unsupported detection for omittable bundles too", () => {
		const order = auctionOrderSchema.parse({
			...nativeBuyAuctionOrder,
			wrappers: [{ address: hint.receiver, data: "0x", isOmittable: true }],
		});
		expect(auctionOrderToRecord(order).hasSettlementWrappers).toBe(true);
	});
});
