import { Hono } from "hono";
import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { BalanceCache, CachedBalance } from "../../../domain/balance-cache.js";
import type { LimitDecision, RateLimiter, TierParams } from "../../../domain/rate-limit.js";
import { AppError, errorHandler, Kind } from "../error.js";
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
	app.use(
		"*",
		ipRateLimit({
			limiter,
			limit: 10,
			windowSecs: 60,
			exemptPaths: ["/healthz"],
			logger: logger as any,
		}),
	);
	app.get("/proposals", (c) => c.json({ ok: true }));
	app.get("/healthz", (c) => c.json({ status: "ok" }));
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

	it("warns at most once a minute, since an exposed origin is absent on every request", async () => {
		const warn = vi.fn();
		const app = guardedApp(scriptedLimiter([{}]), { warn });

		try {
			vi.setSystemTime(2_000_000_000_000);
			await app.request("/proposals");
			await app.request("/proposals");
			await app.request("/proposals");
			expect(warn).toHaveBeenCalledOnce();

			vi.setSystemTime(2_000_000_061_000);
			await app.request("/proposals");
			expect(warn).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("never sheds the liveness probe", async () => {
		// A probe that can be rate limited takes the service out of rotation
		// under exactly the load the limiter exists to absorb.
		const limiter = scriptedLimiter([{ allowed: false, resetAt: 1_700_000_045 }]);
		const app = guardedApp(limiter);

		const res = await app.request("/healthz", {
			headers: { "CF-Connecting-IP": "203.0.113.7" },
		});

		expect(res.status).toBe(200);
		expect(limiter.keys).toEqual([]);
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

	it("rejects a write from a signer known to be below the escrow floor, without spending budget", async () => {
		const limiter = scriptedLimiter([{}]);

		await expect(
			enforceSignerLimit(signerDeps(limiter, 10n ** 15n), SIGNER, { enforceEscrowFloor: true }),
		).rejects.toMatchObject({ kind: "InsufficientEscrow", statusCode: 403 });

		expect(limiter.keys).toEqual([]);
	});

	it("still lets an underfunded signer read and cancel", async () => {
		// effectiveBalance reads zero as soon as requestWithdrawal() is called,
		// so gating every verb would stop a winding-down sub-solver from
		// cancelling the proposals it still has live.
		const limiter = scriptedLimiter([{}, {}]);
		const deps = signerDeps(limiter, 10n ** 15n);

		await expect(enforceSignerLimit(deps, SIGNER)).resolves.toBeUndefined();
		await expect(enforceSignerLimit(deps, SIGNER)).resolves.toBeUndefined();

		expect(limiter.keys).toHaveLength(2);
	});

	it("rejects an exactly-at-floor write nowhere, since the floor is inclusive", async () => {
		// balance === floorWei must pass: the gate has to sit at or below what
		// the validator enforces, never above it.
		const limiter = scriptedLimiter([{}]);

		await expect(
			enforceSignerLimit(signerDeps(limiter, 10n ** 16n), SIGNER, { enforceEscrowFloor: true }),
		).resolves.toBeUndefined();
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

	it("answers 503 when the balance cache is down, not 500", async () => {
		// The limiter and the cache share a Redis connection, so the same
		// problem can surface on either read. A bare 500 here would mean
		// "infrastructure" wearing the status reserved for our own bugs.
		const limiter = scriptedLimiter([{}]);
		const deps = {
			...signerDeps(limiter, "unknown"),
			balances: {
				async lookup(): Promise<CachedBalance> {
					throw new Error("Command timed out");
				},
			},
		};

		await expect(enforceSignerLimit(deps, SIGNER)).rejects.toMatchObject({
			kind: "ServiceUnavailable",
			statusCode: 503,
			retryAfterSecs: expect.any(Number),
		});
	});

	it("lets a verdict out of the cache wrapper unchanged", async () => {
		// A store failure becomes 503, but an AppError is a decision and has to
		// survive. Without the passthrough a cache that rejects a signer would
		// be reported as our infrastructure failing.
		const limiter = scriptedLimiter([{}]);
		const deps = {
			...signerDeps(limiter, "unknown"),
			balances: {
				async lookup(): Promise<CachedBalance> {
					throw new AppError(Kind.InsufficientEscrow);
				},
			},
		};

		await expect(
			enforceSignerLimit(deps, SIGNER, { enforceEscrowFloor: true }),
		).rejects.toMatchObject({
			kind: "InsufficientEscrow",
			statusCode: 403,
		});
	});
});
