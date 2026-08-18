import type { Redis } from "ioredis";
import type { Address } from "viem";
import type { BalanceCache, CachedBalance } from "../domain/balance-cache.js";

export interface RedisBalanceStoreOptions {
	/** Key namespace. Tests override it to isolate against a shared Redis. */
	prefix?: string;
	/** How long a below-floor address stays in the negative set. */
	negativeTtlSecs: number;
}

/**
 * The request-path cache plus the operations the refresh job needs.
 *
 * The split between an active set and a negative set is what keeps the
 * refresh set bounded by real capital rather than by attacker effort: a
 * funded address is refreshed every tick, a below-floor one is parked with
 * a TTL and never refreshed again (ADR-0015).
 */
export interface BalanceEntry {
	address: Address;
	balance: bigint;
}

export interface BalanceStore extends BalanceCache {
	/** Addresses due a refresh, oldest-seen first. */
	activeAddresses(limit: number): Promise<string[]>;
	/** Files freshly fetched balances: at or above `floorWei` the address
	 * stays in the refresh set, below it the address is demoted. */
	record(entries: BalanceEntry[], floorWei: bigint): Promise<void>;
	/** Drops addresses idle past `idleSecs`, then trims the set to
	 * `maxSize`, stalest first. Returns how many were dropped. */
	evict(idleSecs: number, maxSize: number): Promise<number>;
}

const DEFAULT_PREFIX = "byos:bal";

export function createRedisBalanceStore(
	redis: Redis,
	options: RedisBalanceStoreOptions,
): BalanceStore {
	const prefix = options.prefix ?? DEFAULT_PREFIX;
	const activeKey = `${prefix}:active`;
	const balancesKey = `${prefix}:balances`;
	const lowKey = (address: string) => `${prefix}:low:${address}`;

	return {
		async lookup(address: Address): Promise<CachedBalance> {
			const key = address.toLowerCase();

			// One round trip on the attack path: a known-underfunded address
			// answers from the negative set without ever touching the active
			// set, so fresh keypairs cannot grow the refresh population.
			const results = await redis.multi().get(lowKey(key)).hget(balancesKey, key).exec();
			if (!results) throw new Error("redis balance lookup transaction aborted");
			for (const [err] of results) {
				if (err) throw err;
			}

			const low = results[0]?.[1] as string | null;
			if (low !== null && low !== undefined) return BigInt(low);

			await redis.zadd(activeKey, Date.now(), key);

			const known = results[1]?.[1] as string | null;
			return known === null || known === undefined ? "unknown" : BigInt(known);
		},

		async activeAddresses(limit: number): Promise<string[]> {
			return redis.zrange(activeKey, 0, limit - 1);
		},

		async record(entries: BalanceEntry[], floorWei: bigint): Promise<void> {
			if (entries.length === 0) return;

			const tx = redis.multi();
			for (const { address, balance } of entries) {
				const key = address.toLowerCase();
				if (balance >= floorWei) {
					tx.hset(balancesKey, key, balance.toString());
					// NX: promote a demoted address back into the refresh set,
					// but never touch an existing score. The score is last-seen
					// on the API (ADR-0015), not last-refreshed — overwriting it
					// here would push every funded address past the idle cutoff
					// on every tick, so eviction could never fire.
					tx.zadd(activeKey, "NX", Date.now(), key);
					tx.del(lowKey(key));
				} else {
					tx.set(lowKey(key), balance.toString(), "EX", options.negativeTtlSecs);
					tx.zrem(activeKey, key);
					tx.hdel(balancesKey, key);
				}
			}

			const results = await tx.exec();
			if (!results) throw new Error("redis balance record transaction aborted");
			for (const [err] of results) {
				if (err) throw err;
			}
		},

		/**
		 * The size cap is what bounds this set by memory rather than by
		 * attacker courtesy. Age eviction alone leaves a window one refresh
		 * interval wide in which fresh keypairs accumulate unbounded, because
		 * nothing has fetched their balances yet to demote them.
		 */
		async evict(idleSecs: number, maxSize: number): Promise<number> {
			const cutoff = Date.now() - idleSecs * 1000;

			const results = await redis
				.multi()
				.zremrangebyscore(activeKey, "-inf", cutoff)
				.zremrangebyrank(activeKey, 0, -maxSize - 1)
				.exec();

			if (!results) throw new Error("redis balance evict transaction aborted");
			for (const [err] of results) {
				if (err) throw err;
			}

			return Number(results[0]?.[1] ?? 0) + Number(results[1]?.[1] ?? 0);
		},
	};
}
