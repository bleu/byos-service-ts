import { Redis } from "ioredis";
import type { Address } from "viem";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createRedisBalanceStore } from "../balance-cache.js";

const REDIS_URL = process.env.BYOS_TEST_REDIS_URL ?? "redis://localhost:6379";
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

let counter = 0;
function freshStore() {
	return createRedisBalanceStore(redis, {
		prefix: `byos:test:${process.pid}:${Date.now()}:${counter++}`,
		negativeTtlSecs: 600,
	});
}

const FUNDED = "0xAaA1111111111111111111111111111111111111" as Address;
const BROKE = "0xBbB2222222222222222222222222222222222222" as Address;
const FLOOR = 10n ** 16n;

afterEach(async () => {
	const keys = await redis.keys(`byos:test:${process.pid}:*`);
	if (keys.length > 0) await redis.del(...keys);
});

afterAll(async () => {
	await redis.quit();
});

describe("redis balance store", () => {
	it("reports a never-seen address as unknown and enrols it for refresh", async () => {
		const store = freshStore();

		await expect(store.lookup(FUNDED)).resolves.toBe("unknown");

		expect(await store.activeAddresses(10)).toEqual([FUNDED.toLowerCase()]);
	});

	it("serves a recorded balance to the request path", async () => {
		const store = freshStore();
		await store.lookup(FUNDED);

		await store.record([{ address: FUNDED, balance: 5n * 10n ** 17n }], FLOOR);

		await expect(store.lookup(FUNDED)).resolves.toBe(5n * 10n ** 17n);
	});

	it("demotes a below-floor address out of the refresh set", async () => {
		const store = freshStore();
		await store.lookup(BROKE);

		await store.record([{ address: BROKE, balance: 1n }], FLOOR);

		expect(await store.activeAddresses(10)).toEqual([]);
		await expect(store.lookup(BROKE)).resolves.toBe(1n);
	});

	it("keeps a demoted address out of the refresh set however often it calls", async () => {
		const store = freshStore();
		await store.lookup(BROKE);
		await store.record([{ address: BROKE, balance: 1n }], FLOOR);

		for (let i = 0; i < 5; i++) await store.lookup(BROKE);

		expect(await store.activeAddresses(10)).toEqual([]);
	});

	it("promotes an address back once it funds above the floor", async () => {
		const store = freshStore();
		await store.lookup(BROKE);
		await store.record([{ address: BROKE, balance: 1n }], FLOOR);

		await store.record([{ address: BROKE, balance: 10n ** 18n }], FLOOR);

		expect(await store.activeAddresses(10)).toEqual([BROKE.toLowerCase()]);
		await expect(store.lookup(BROKE)).resolves.toBe(10n ** 18n);
	});

	it("evicts an address idle past the eviction age", async () => {
		const store = freshStore();
		vi.useFakeTimers({ shouldAdvanceTime: false });
		try {
			vi.setSystemTime(1_700_000_000_000);
			await store.lookup(FUNDED);

			// Two hours later. MAX_PROPOSAL_LIFETIME_SECS is 300, so an address
			// idle this long cannot still hold live proposals — eviction can
			// never orphan reserve accounting.
			vi.setSystemTime(1_700_000_000_000 + 2 * 3600 * 1000);
			const evicted = await store.evict(3600, 100_000);

			expect(evicted).toBe(1);
			expect(await store.activeAddresses(10)).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not let a refresh reset the last-seen clock", async () => {
		// The score is last-seen on the API, not last-refreshed. A funded
		// address is re-filed every tick, so if record() overwrote the score
		// the idle cutoff could never be reached and nothing would ever age
		// out of the refresh set.
		const store = freshStore();
		vi.useFakeTimers({ shouldAdvanceTime: false });
		try {
			const t0 = 1_700_000_000_000;
			vi.setSystemTime(t0);
			await store.lookup(FUNDED);

			// Two hours of refresh ticks with no further API traffic.
			for (let minute = 1; minute <= 120; minute++) {
				vi.setSystemTime(t0 + minute * 60 * 1000);
				await store.record([{ address: FUNDED, balance: 10n ** 18n }], FLOOR);
			}

			expect(await store.evict(3600, 100_000)).toBe(1);
			expect(await store.activeAddresses(10)).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a recently-seen address through an eviction sweep", async () => {
		const store = freshStore();
		await store.lookup(FUNDED);

		await store.evict(3600, 100_000);

		expect(await store.activeAddresses(10)).toEqual([FUNDED.toLowerCase()]);
	});

	it("trims the refresh set to its cap, dropping the stalest first", async () => {
		const store = freshStore();
		vi.useFakeTimers({ shouldAdvanceTime: false });
		try {
			// Three addresses seen a second apart; only the two newest fit.
			for (let i = 0; i < 3; i++) {
				vi.setSystemTime(1_700_000_000_000 + i * 1000);
				await store.lookup(`0x${String(i).repeat(40)}` as Address);
			}

			await store.evict(3600, 2);

			expect(await store.activeAddresses(10)).toEqual([
				`0x${"1".repeat(40)}`,
				`0x${"2".repeat(40)}`,
			]);
		} finally {
			vi.useRealTimers();
		}
	});
});
