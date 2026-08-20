import { Redis } from "ioredis";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createRequestPathRedisConnection } from "../jobs/index.js";
import { createRedisRateLimiter } from "../rate-limit.js";

const REDIS_URL = process.env.BYOS_TEST_REDIS_URL ?? "redis://localhost:6379";
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

/** Each test gets its own key namespace so a shared Redis stays safe to
 * run against — the same isolation discipline the shared-DB e2e tier uses. */
let counter = 0;
function freshPrefix(): string {
	return `byos:test:${process.pid}:${Date.now()}:${counter++}`;
}

afterEach(async () => {
	const keys = await redis.keys(`byos:test:${process.pid}:*`);
	if (keys.length > 0) await redis.del(...keys);
});

afterAll(async () => {
	await redis.quit();
});

describe("redis rate limiter", () => {
	it("allows the first request and reports the budget left", async () => {
		const limiter = createRedisRateLimiter(redis, { prefix: freshPrefix() });

		const decision = await limiter.checkLimit("signer:0xabc", 10, 60);

		expect(decision.allowed).toBe(true);
		expect(decision.remaining).toBe(9);
	});

	it("denies the request that exceeds the limit", async () => {
		const limiter = createRedisRateLimiter(redis, { prefix: freshPrefix() });

		for (let i = 0; i < 3; i++) {
			const decision = await limiter.checkLimit("signer:0xabc", 3, 60);
			expect(decision.allowed).toBe(true);
		}

		const denied = await limiter.checkLimit("signer:0xabc", 3, 60);
		expect(denied.allowed).toBe(false);
		expect(denied.remaining).toBe(0);
	});

	it("returns budget as the window slides, without a cliff at the boundary", async () => {
		const limiter = createRedisRateLimiter(redis, { prefix: freshPrefix() });
		const windowSecs = 2;

		// Start on an exact window boundary so the arithmetic is legible.
		const boundary = Math.ceil(Date.now() / (windowSecs * 1000)) * windowSecs * 1000;
		vi.useFakeTimers({ shouldAdvanceTime: false });
		try {
			vi.setSystemTime(boundary);

			// Spend the whole budget inside this window.
			for (let i = 0; i < 10; i++) {
				await limiter.checkLimit("signer:0xabc", 10, windowSecs);
			}
			expect((await limiter.checkLimit("signer:0xabc", 10, windowSecs)).allowed).toBe(false);

			// A tenth of the way into the next window: the old count still
			// weighs 90%, so the budget has not reset.
			vi.setSystemTime(boundary + windowSecs * 1000 + 200);
			expect((await limiter.checkLimit("signer:0xabc", 10, windowSecs)).allowed).toBe(false);

			// Nine tenths through: the old window has decayed out of reach.
			vi.setSystemTime(boundary + windowSecs * 1000 + 1800);
			expect((await limiter.checkLimit("signer:0xabc", 10, windowSecs)).allowed).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps separate keys on separate budgets", async () => {
		const limiter = createRedisRateLimiter(redis, { prefix: freshPrefix() });

		for (let i = 0; i < 3; i++) {
			await limiter.checkLimit("signer:0xaaa", 3, 60);
		}
		expect((await limiter.checkLimit("signer:0xaaa", 3, 60)).allowed).toBe(false);
		expect((await limiter.checkLimit("signer:0xbbb", 3, 60)).allowed).toBe(true);
	});

	it("throws when Redis is unreachable instead of deciding", async () => {
		// An unreachable store is not a rate-limit verdict. Swallowing it
		// into allowed:true opens the gate during an outage; into
		// allowed:false it reports 429 for what is a 503.
		//
		// Built with the real production factory, not a hand-tuned client:
		// the BullMQ connection's options queue the command and wait for a
		// reconnect instead of failing, so a test that configures its own
		// client proves nothing about the deployed limiter.
		const broken = createRequestPathRedisConnection("redis://127.0.0.1:1");
		broken.on("error", () => {});
		const limiter = createRedisRateLimiter(broken, { prefix: freshPrefix() });

		try {
			await expect(limiter.checkLimit("signer:0xabc", 10, 60)).rejects.toThrow();
		} finally {
			broken.disconnect();
		}
	});

	it("does not hang on an unreachable Redis, so callers can answer 503", async () => {
		// The failure has to be prompt as well as thrown: checkBudget turns a
		// rejection into 503, but a pending promise is a hung request that no
		// response timeout bounds.
		const broken = createRequestPathRedisConnection("redis://127.0.0.1:1");
		broken.on("error", () => {});
		const limiter = createRedisRateLimiter(broken, { prefix: freshPrefix() });

		try {
			const settled = await Promise.race([
				limiter.checkLimit("signer:0xabc", 10, 60).then(
					() => "resolved",
					() => "rejected",
				),
				new Promise((r) => setTimeout(() => r("pending"), 2000)),
			]);
			expect(settled).toBe("rejected");
		} finally {
			broken.disconnect();
		}
	});
});
