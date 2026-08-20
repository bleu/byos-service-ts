import type { Redis } from "ioredis";
import type { LimitDecision, RateLimiter } from "../domain/rate-limit.js";
import { slidingCount } from "../domain/rate-limit.js";

export interface RedisRateLimiterOptions {
	/** Key namespace. Tests override it to isolate against a shared Redis. */
	prefix?: string;
}

const DEFAULT_PREFIX = "byos:rl";

/**
 * Sliding window counter over two fixed-window keys, O(1) memory per subject.
 *
 * A denied request still increments its counter. That is deliberate: a
 * flooding client keeps its own budget pinned, and the rejection stays a
 * single pipeline round trip. The reference sub-solver does not back off
 * (it swallows errors and retries next tick), so the reject path has to
 * stay cheap.
 */
export function createRedisRateLimiter(
	redis: Redis,
	options: RedisRateLimiterOptions = {},
): RateLimiter {
	const prefix = options.prefix ?? DEFAULT_PREFIX;

	return {
		async checkLimit(key: string, limit: number, windowSecs: number): Promise<LimitDecision> {
			const nowMs = Date.now();
			const windowMs = windowSecs * 1000;
			const windowIndex = Math.floor(nowMs / windowMs);
			const elapsedRatio = (nowMs % windowMs) / windowMs;

			const currentKey = `${prefix}:${key}:${windowIndex}`;
			const previousKey = `${prefix}:${key}:${windowIndex - 1}`;

			// One round trip. The current counter outlives its own window by
			// one full window, because the next window still reads it.
			const results = await redis
				.multi()
				.incr(currentKey)
				.expire(currentKey, windowSecs * 2)
				.get(previousKey)
				.exec();

			if (!results) {
				throw new Error("redis rate limit transaction aborted");
			}
			for (const [err] of results) {
				if (err) throw err;
			}

			const current = Number(results[0]?.[1] ?? 0);
			const previous = Number(results[2]?.[1] ?? 0);
			const count = slidingCount(previous, current, elapsedRatio);

			const resetAt = Math.ceil(((windowIndex + 1) * windowMs) / 1000);
			return {
				allowed: count <= limit,
				remaining: Math.max(0, Math.floor(limit - count)),
				resetAt,
			};
		},
	};
}
