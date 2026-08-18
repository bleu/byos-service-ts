import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Address } from "viem";
import type { BalanceStore } from "../balance-cache.js";

export interface BalanceRefreshConfig {
	store: BalanceStore;
	/** Batched escrow read. Injected so the tick is testable without RPC.
	 * `null` means the read failed for that address. */
	fetchBalances: (addresses: Address[]) => Promise<(bigint | null)[]>;
	floorWei: bigint;
	evictionSecs: number;
	maxActive: number;
	batchSize: number;
	logger: Logger;
}

/**
 * Refreshes the escrow balances the request path reads.
 *
 * Redundant with the validator, which must read balances itself to stay
 * authoritative and so cannot consume this cache. Accepted (ADR-0015); the
 * cheap fix, if it ever matters, is to have the validator write through.
 */
export async function runBalanceRefresh(config: BalanceRefreshConfig): Promise<void> {
	const { store, fetchBalances, floorWei, evictionSecs, maxActive, batchSize, logger } = config;

	try {
		const evicted = await store.evict(evictionSecs, maxActive);
		if (evicted > 0) {
			logger.info({ evicted }, "evicted idle sub-solvers from the balance refresh set");
		}
	} catch (err) {
		logger.error({ err }, "balance eviction failed");
	}

	let addresses: string[];
	try {
		addresses = await store.activeAddresses(maxActive);
	} catch (err) {
		logger.error({ err }, "failed to read the balance refresh set");
		return;
	}

	for (let i = 0; i < addresses.length; i += batchSize) {
		const batch = addresses.slice(i, i + batchSize) as Address[];
		try {
			const balances = await fetchBalances(batch);
			// An address whose read failed is left as it was. Filing it as
			// zero would demote a funded sub-solver on a dropped RPC call.
			const entries = batch.flatMap((address, j) => {
				const balance = balances[j];
				return balance == null ? [] : [{ address, balance }];
			});
			await store.record(entries, floorWei);
		} catch (err) {
			// Leave the batch as it was: a stale balance is a tier that is
			// one tick old, while dropping it would demote a funded sub-solver.
			logger.warn({ err, size: batch.length }, "balance refresh batch failed");
		}
	}
}

export function createBalanceRefreshWorker(
	connection: Redis,
	config: BalanceRefreshConfig,
): Worker {
	return new Worker("byos:balance-refresh", async () => await runBalanceRefresh(config), {
		connection,
		concurrency: 1,
	});
}
