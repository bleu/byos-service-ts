import type { Address } from "viem";

/** A signer's escrow balance as the request path sees it. `"unknown"` means
 * first contact — no balance has been fetched yet. */
export type CachedBalance = bigint | "unknown";

/**
 * Cached escrow balances for the request path. Never does RPC: ADR-0001's
 * property is that no chain read enters the proposal API, and the
 * authoritative balance check stays in the background validator.
 *
 * `lookup` also marks the address as active, which is what enrols it in the
 * refresh job.
 */
export interface BalanceCache {
	lookup(address: Address): Promise<CachedBalance>;
}

/** Stub cache that never knows a balance. Used when no RPC is configured
 * and in tests, mirroring `acceptAll` in ./validator.ts. */
export const unknownBalances: BalanceCache = {
	async lookup(): Promise<CachedBalance> {
		return "unknown";
	},
};
