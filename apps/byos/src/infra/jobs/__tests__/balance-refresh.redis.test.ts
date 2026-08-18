import { Redis } from "ioredis";
import pino from "pino";
import type { Address } from "viem";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createRedisBalanceStore } from "../../balance-cache.js";
import { type BalanceRefreshConfig, runBalanceRefresh } from "../balance-refresh.js";

const REDIS_URL = process.env.BYOS_TEST_REDIS_URL ?? "redis://localhost:6379";
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const logger = pino({ level: "silent" });

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

function refreshConfig(store: ReturnType<typeof freshStore>, balances: Record<string, bigint>) {
	const fetchBalances = vi.fn(async (addresses: Address[]) =>
		addresses.map((a): bigint | null => balances[a.toLowerCase()] ?? 0n),
	);
	const config: BalanceRefreshConfig = {
		store,
		fetchBalances,
		floorWei: FLOOR,
		evictionSecs: 3600,
		maxActive: 100_000,
		batchSize: 50,
		logger,
	};
	return { config, fetchBalances };
}

afterEach(async () => {
	const keys = await redis.keys(`byos:test:${process.pid}:*`);
	if (keys.length > 0) await redis.del(...keys);
});

afterAll(async () => {
	await redis.quit();
});

describe("balance refresh tick", () => {
	it("turns a first-contact address into a known balance", async () => {
		const store = freshStore();
		await store.lookup(FUNDED);
		const { config } = refreshConfig(store, { [FUNDED.toLowerCase()]: 5n * 10n ** 17n });

		await runBalanceRefresh(config);

		await expect(store.lookup(FUNDED)).resolves.toBe(5n * 10n ** 17n);
	});

	it("demotes a below-floor address so it is never fetched again", async () => {
		const store = freshStore();
		await store.lookup(BROKE);
		const { config, fetchBalances } = refreshConfig(store, { [BROKE.toLowerCase()]: 1n });

		await runBalanceRefresh(config);
		fetchBalances.mockClear();
		await runBalanceRefresh(config);

		expect(fetchBalances).not.toHaveBeenCalled();
	});

	it("leaves a funded solver's tier alone when the escrow read fails", async () => {
		const store = freshStore();
		await store.lookup(FUNDED);
		const { config } = refreshConfig(store, { [FUNDED.toLowerCase()]: 5n * 10n ** 17n });
		await runBalanceRefresh(config);

		// A dropped RPC must not read as "balance zero" and demote the solver.
		config.fetchBalances = async () => {
			throw new Error("RPC timeout");
		};
		await runBalanceRefresh(config);

		await expect(store.lookup(FUNDED)).resolves.toBe(5n * 10n ** 17n);
		expect(await store.activeAddresses(10)).toEqual([FUNDED.toLowerCase()]);
	});

	it("skips an address whose escrow read failed, rather than filing it as zero", async () => {
		const store = freshStore();
		await store.lookup(FUNDED);
		const { config } = refreshConfig(store, { [FUNDED.toLowerCase()]: 5n * 10n ** 17n });
		await runBalanceRefresh(config);

		config.fetchBalances = async () => [null];
		await runBalanceRefresh(config);

		await expect(store.lookup(FUNDED)).resolves.toBe(5n * 10n ** 17n);
		expect(await store.activeAddresses(10)).toEqual([FUNDED.toLowerCase()]);
	});

	it("fetches in batches so one multicall cannot grow without bound", async () => {
		const store = freshStore();
		for (let i = 0; i < 5; i++) {
			await store.lookup(`0x${String(i).repeat(40)}` as Address);
		}
		const { config, fetchBalances } = refreshConfig(store, {});
		config.batchSize = 2;

		await runBalanceRefresh(config);

		expect(fetchBalances.mock.calls.map((c) => c[0].length)).toEqual([2, 2, 1]);
	});

	it("sweeps idle addresses before spending an escrow read on them", async () => {
		const store = freshStore();
		vi.useFakeTimers({ shouldAdvanceTime: false });
		try {
			vi.setSystemTime(1_700_000_000_000);
			await store.lookup(FUNDED);
			vi.setSystemTime(1_700_000_000_000 + 2 * 3600 * 1000);

			const { config, fetchBalances } = refreshConfig(store, {});
			await runBalanceRefresh(config);

			expect(fetchBalances).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
