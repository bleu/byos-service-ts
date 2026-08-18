import { Hono } from "hono";
import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { BalanceCache, CachedBalance } from "../../../domain/balance-cache.js";
import type { LimitDecision, RateLimiter, TierParams } from "../../../domain/rate-limit.js";
import { errorHandler } from "../error.js";
import { enforceSignerLimit, ipRateLimit } from "../middleware.js";

/** Records what it was asked and answers from a script. */
function scriptedLimiter(
	answers: Partial<LimitDecision>[],
): RateLimiter & { keys: string[]; limits: number[] } {
	const keys: string[] = [];
	const limits: number[] = [];
	let i = 0;
	return {
		keys,
		limits,
		async checkLimit(key, limit) {
			keys.push(key);
			limits.push(limit);
			const answer = answers[Math.min(i++, answers.length - 1)] ?? {};
			return { allowed: true, remaining: 0, resetAt: 1_700_000_060, ...answer };
		},
	};
}

const SIGNER = "0xAbC1111111111111111111111111111111111111" as Address;

const TIER: TierParams = {
	rateUnitWei: 10n ** 17n,
	ratePerUnit: 300,
	minRate: 120,
	maxRate: 3000,
};

function balancesOf(balance: CachedBalance): BalanceCache {
	return {
		async lookup(): Promise<CachedBalance> {
			return balance;
		},
	};
}

function signerDeps(limiter: RateLimiter, balance: CachedBalance) {
	return {
		limiter,
		balances: balancesOf(balance),
		tier: TIER,
		windowSecs: 60,
		floorWei: 10n ** 16n,
	};
}

function guardedApp(limiter: RateLimiter, logger?: { warn: (o: unknown, m: string) => void }) {
	const app = new Hono();
	app.onError(errorHandler);
	// biome-ignore lint/suspicious/noExplicitAny: test double for pino
	app.use("*", ipRateLimit({ limiter, limit: 10, windowSecs: 60, logger: logger as any }));
	app.get("/proposals", (c) => c.json({ ok: true }));
	return app;
}

describe("ip rate limit backstop", () => {
	it("sheds a flooding IP with 429 and a Retry-After", async () => {
		vi.setSystemTime(1_700_000_000_000);
		const app = guardedApp(scriptedLimiter([{ allowed: false, resetAt: 1_700_000_045 }]));

		const res = await app.request("/proposals", {
			headers: { "CF-Connecting-IP": "203.0.113.7" },
		});

		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("45");
		vi.useRealTimers();
	});

	it("keys the budget on CF-Connecting-IP", async () => {
		const limiter = scriptedLimiter([{}]);
		const app = guardedApp(limiter);

		await app.request("/proposals", { headers: { "CF-Connecting-IP": "203.0.113.7" } });

		expect(limiter.keys).toEqual(["ip:203.0.113.7"]);
	});

	it("warns when CF-Connecting-IP is absent, since that means the origin is exposed", async () => {
		const warn = vi.fn();
		const app = guardedApp(scriptedLimiter([{}]), { warn });

		await app.request("/proposals");

		expect(warn).toHaveBeenCalledOnce();
	});

	it("answers 503 when the limiter's store is down, not 429", async () => {
		const app = guardedApp({
			async checkLimit() {
				throw new Error("ECONNREFUSED");
			},
		});

		const res = await app.request("/proposals", {
			headers: { "CF-Connecting-IP": "203.0.113.7" },
		});

		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBeTruthy();
		await expect(res.json()).resolves.toMatchObject({ kind: "ServiceUnavailable" });
	});
});

describe("per-signer limit", () => {
	it("admits a never-seen signer at the lowest tier", async () => {
		const limiter = scriptedLimiter([{}]);

		await expect(
			enforceSignerLimit(signerDeps(limiter, "unknown"), SIGNER),
		).resolves.toBeUndefined();

		expect(limiter.limits).toEqual([120]);
	});

	it("scales the budget with escrow balance", async () => {
		const limiter = scriptedLimiter([{}]);

		await enforceSignerLimit(signerDeps(limiter, 3n * 10n ** 17n), SIGNER);

		expect(limiter.limits).toEqual([900]);
	});

	it("rejects a signer known to be below the escrow floor, without spending budget", async () => {
		const limiter = scriptedLimiter([{}]);

		await expect(enforceSignerLimit(signerDeps(limiter, 10n ** 15n), SIGNER)).rejects.toMatchObject(
			{ kind: "InsufficientEscrow", statusCode: 403 },
		);

		expect(limiter.keys).toEqual([]);
	});

	it("keys on the signer alone, so GET, POST and DELETE share one budget", async () => {
		const limiter = scriptedLimiter([{}, {}]);
		const deps = signerDeps(limiter, "unknown");

		await enforceSignerLimit(deps, SIGNER);
		await enforceSignerLimit(deps, SIGNER);

		expect(limiter.keys).toEqual([
			"signer:0xabc1111111111111111111111111111111111111",
			"signer:0xabc1111111111111111111111111111111111111",
		]);
	});

	it("rate-limits an over-budget signer with 429 and a Retry-After", async () => {
		vi.setSystemTime(1_700_000_000_000);
		const limiter = scriptedLimiter([{ allowed: false, resetAt: 1_700_000_030 }]);

		await expect(enforceSignerLimit(signerDeps(limiter, "unknown"), SIGNER)).rejects.toMatchObject({
			kind: "RateLimited",
			statusCode: 429,
			retryAfterSecs: 30,
		});
		vi.useRealTimers();
	});
});
