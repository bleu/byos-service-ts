import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestContext } from "../../../test/setup.js";
import * as store from "../storage.js";

let ctx: TestContext;

beforeAll(async () => {
	ctx = await createTestDb();
});

afterAll(async () => {
	await ctx.cleanup();
});

describe("auction gas price", () => {
	it("makes the latest auction price available to a separate worker context", async () => {
		const defaultGasPrice = 10_000_000_000n;
		await store.publishAuctionGasPrice(ctx.db, 42_000_000_000n);

		const validatorGasPrice = await store.latestAuctionGasPrice(ctx.db, defaultGasPrice);

		expect(validatorGasPrice).toBe(42_000_000_000n);
	});

	it("retains the configured fallback before an auction has published a price", async () => {
		const fresh = await createTestDb();
		try {
			expect(await store.latestAuctionGasPrice(fresh.db, 10_000_000_000n)).toBe(10_000_000_000n);
		} finally {
			await fresh.cleanup();
		}
	});
});
