import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AppError, errorHandler, Kind } from "../error.js";

function appThatThrows(err: Error): Hono {
	const app = new Hono();
	app.onError(errorHandler);
	app.get("/boom", () => {
		throw err;
	});
	return app;
}

describe("rate limit errors", () => {
	it("a rate-limited signer gets 429 with a Retry-After", async () => {
		const app = appThatThrows(new AppError(Kind.RateLimited, undefined, 30));

		const res = await app.request("/boom");

		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("30");
		await expect(res.json()).resolves.toMatchObject({ kind: "RateLimited" });
	});

	it("an unavailable backing store gets 503, never conflated with 429", async () => {
		const app = appThatThrows(new AppError(Kind.ServiceUnavailable, undefined, 5));

		const res = await app.request("/boom");

		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBe("5");
		await expect(res.json()).resolves.toMatchObject({ kind: "ServiceUnavailable" });
	});

	it("errors without a retry hint carry no Retry-After", async () => {
		const app = appThatThrows(new AppError(Kind.BadRequest));

		const res = await app.request("/boom");

		expect(res.status).toBe(400);
		expect(res.headers.get("Retry-After")).toBeNull();
	});
});
