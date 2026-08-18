/** Constants of the escrow tier function. All are operational tuning
 * parameters — see ADR-0015. */
export interface TierParams {
	/** Escrow wei that buys one unit of throughput. */
	rateUnitWei: bigint;
	/** Requests per window granted per unit. */
	ratePerUnit: number;
	/** Floor, applied to unfunded and unknown signers alike. */
	minRate: number;
	/** Ceiling. Load-bearing: without it a single well-funded signer's
	 * allowance can exceed the edge limit and starve everyone else. */
	maxRate: number;
}

/**
 * Requests per window a signer holding `balance` may spend.
 *
 * Deliberately gas-independent, unlike the escrow reserve unit: `threshold()`
 * contains `gasPrice`, so reusing it would let a gas spike collapse every
 * sub-solver's allowance at once.
 */
export function rateForBalance(balance: bigint, params: TierParams): number {
	const units = balance / params.rateUnitWei;
	const rate = units * BigInt(params.ratePerUnit);
	if (rate <= BigInt(params.minRate)) return params.minRate;
	if (rate >= BigInt(params.maxRate)) return params.maxRate;
	return Number(rate);
}

/**
 * Two fixed-window counters interpolated into one sliding estimate.
 *
 * `elapsedRatio` is how far into the current window the request lands, in
 * [0, 1). The previous window's count is weighted by how much of it is still
 * inside the trailing window.
 *
 * A sliding window *log* would be exact, but its memory grows with traffic
 * rather than with subjects, so an attacker inflates Redis directly by
 * sending requests. Cost that grows with the attack is the wrong shape for
 * a DDoS control (ADR-0015).
 */
export function slidingCount(previous: number, current: number, elapsedRatio: number): number {
	return previous * (1 - elapsedRatio) + current;
}

/** Outcome of one budget check. `resetAt` is unix seconds. */
export interface LimitDecision {
	allowed: boolean;
	remaining: number;
	resetAt: number;
}

/**
 * One budget check against one key. Both the IP backstop and the per-signer
 * limit go through this, so the internals can become a token bucket later
 * without touching either call site.
 *
 * Throws on backing-store failure — callers answer 503, never 429. A store
 * error is not a rate-limit decision and must not be swallowed into one.
 */
export interface RateLimiter {
	checkLimit(key: string, limit: number, windowSecs: number): Promise<LimitDecision>;
}

/** Stub limiter that allows everything. Used for local dev and tests,
 * mirroring `acceptAll` in ./validator.ts. */
export const allowAll: RateLimiter = {
	async checkLimit(_key: string, limit: number, windowSecs: number): Promise<LimitDecision> {
		return {
			allowed: true,
			remaining: limit,
			resetAt: Math.floor(Date.now() / 1000) + windowSecs,
		};
	},
};
