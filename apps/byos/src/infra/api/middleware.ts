import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import type { Logger } from "pino";
import type { Address, Hex } from "viem";
import type { BalanceCache } from "../../domain/balance-cache.js";
import type { LimitDecision, RateLimiter, TierParams } from "../../domain/rate-limit.js";
import { rateForBalance } from "../../domain/rate-limit.js";
import { AppError, Kind } from "./error.js";

/** Bearer token auth middleware for internal routes. Any failure answers a
 * bare 401 with a WWW-Authenticate challenge, matching the Rust guard —
 * one uniform response, no error body to distinguish failure modes. */
export function bearerAuth(expectedToken: string): MiddlewareHandler {
	return async (c, next) => {
		const header = c.req.header("Authorization");
		// RFC 7235: the auth scheme name is case-insensitive ("Bearer" ==
		// "bearer"); the token itself is not. Split at the first space only,
		// so a token containing spaces still compares whole.
		const space = header?.indexOf(" ") ?? -1;
		const authorized =
			header !== undefined &&
			space > 0 &&
			header.slice(0, space).toLowerCase() === "bearer" &&
			header.slice(space + 1) === expectedToken;

		if (!authorized) {
			c.header("WWW-Authenticate", "Bearer");
			return c.body(null, 401);
		}

		await next();
	};
}

/** Extracts and validates the X-Signature header: hex with an optional 0x
 * prefix, exactly 65 bytes. Failures are invalidSignature, as in Rust's
 * signature_from_header. */
export function extractSignature(c: Context): Hex {
	const sig = c.req.header("X-Signature");
	if (!sig) {
		throw new AppError(Kind.InvalidSignature, "missing X-Signature header");
	}
	if (!/^(0x)?([0-9a-fA-F]{2})*$/.test(sig)) {
		throw new AppError(Kind.InvalidSignature, "X-Signature is not valid hex");
	}
	const bare = sig.startsWith("0x") ? sig.slice(2) : sig;
	if (bare.length !== 130) {
		throw new AppError(Kind.InvalidSignature, "invalid signature bytes");
	}
	return `0x${bare}` as Hex;
}

export interface IpRateLimitConfig {
	limiter: RateLimiter;
	limit: number;
	windowSecs: number;
	logger?: Logger;
}

/** Seconds a client should wait, from a window that resets at `resetAt`. */
function retryAfter(resetAt: number): number {
	return Math.max(1, resetAt - Math.floor(Date.now() / 1000));
}

/** How long to tell a client to wait out a limiter-store outage. Not
 * window-shaped: ioredis reconnects on its own, and the reference sub-solver
 * retries next tick regardless. */
const STORE_RETRY_AFTER_SECS = 5;

/**
 * Runs one budget check, translating a store failure into 503 rather than
 * letting it become a 429 or a 500.
 *
 * Fail-closed is the right default here. Redis is already a hard dependency
 * for BullMQ, so during an outage nothing gets validated and audit events
 * are dropped — accepting proposals would mean taking on unprovable Track B
 * liability to preserve an availability number that is already fictional
 * (ADR-0015). The status split also reads clearly in logs: a spike in 429s
 * is load, a spike in 503s is infrastructure.
 */
export async function checkBudget(
	limiter: RateLimiter,
	key: string,
	limit: number,
	windowSecs: number,
	logger?: Logger,
): Promise<LimitDecision> {
	try {
		return await limiter.checkLimit(key, limit, windowSecs);
	} catch (err) {
		logger?.error({ err, key }, "rate limit store unavailable");
		throw new AppError(Kind.ServiceUnavailable, undefined, STORE_RETRY_AFTER_SECS);
	}
}

/**
 * Loose per-IP backstop on the public listener.
 *
 * The primary per-IP limit lives at the Cloudflare edge, where a rejected
 * request costs no socket, no ecrecover, and no connection-pool slot. This
 * is defense in depth against our own misconfiguration — a broken origin
 * lockdown, or a tunnel replaced during a deploy — not against an attacker
 * who beat Cloudflare. See ADR-0015.
 */
export function ipRateLimit(config: IpRateLimitConfig): MiddlewareHandler {
	const { limiter, limit, windowSecs, logger } = config;

	return async (c, next) => {
		const key = `ip:${clientIp(c, logger)}`;
		const decision = await checkBudget(limiter, key, limit, windowSecs, logger);
		if (!decision.allowed) {
			throw new AppError(Kind.RateLimited, undefined, retryAfter(decision.resetAt));
		}
		await next();
	};
}

function clientIp(c: Context, logger?: Logger): string {
	const forwarded = c.req.header("CF-Connecting-IP");
	if (forwarded) return forwarded;

	// In a correct deployment the origin is unreachable except through
	// Cloudflare, so this header is always present. Its absence means the
	// lockdown is broken and the limit is keying on something else.
	logger?.warn({ path: c.req.path }, "CF-Connecting-IP absent — origin lockdown may be broken");

	try {
		return getConnInfo(c).remote.address ?? "unknown";
	} catch {
		return "unknown";
	}
}

export interface SignerLimitConfig {
	limiter: RateLimiter;
	balances: BalanceCache;
	tier: TierParams;
	windowSecs: number;
	/** Escrow floor below which a known signer is rejected synchronously. */
	floorWei: bigint;
	logger?: Logger;
}

/**
 * The per-signer budget (layer 4) and the escrow floor gate (layer 5).
 *
 * Called by each public route after signature recovery, not as middleware —
 * there is no signer to key on until `ecrecover` has run.
 *
 * One budget covers GET, POST and DELETE, sized from read volume: the
 * reference client polls every live proposal each tick, so reads dominate
 * and writes ride along inside a read-sized allowance.
 */
export async function enforceSignerLimit(
	config: SignerLimitConfig,
	signer: Address,
): Promise<void> {
	const { limiter, balances, tier, windowSecs, floorWei, logger } = config;

	const balance = await balances.lookup(signer);

	// Layer 5. A known-underfunded signer is rejected before it costs a
	// budget check. Unknown stays admitted — the cache is a negative signal
	// only, and rejecting on absence would lock out every new sub-solver.
	//
	// The floor is MIN_COLLATERAL, deliberately not the validator's
	// gas-coupled threshold: it must sit at or below whatever the validator
	// enforces, so this gate can never reject a proposal the validator would
	// have accepted.
	if (balance !== "unknown" && balance < floorWei) {
		throw new AppError(Kind.InsufficientEscrow);
	}

	const rate = rateForBalance(balance === "unknown" ? 0n : balance, tier);

	const decision = await checkBudget(
		limiter,
		`signer:${signer.toLowerCase()}`,
		rate,
		windowSecs,
		logger,
	);
	if (!decision.allowed) {
		throw new AppError(Kind.RateLimited, undefined, retryAfter(decision.resetAt));
	}
}
