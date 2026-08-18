import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { createPublicApp, type PublicAppContext } from "../index.js";

/**
 * Every public route and what it must spend.
 *
 * This exists because the signer budget is applied per handler, after
 * `ecrecover` — there is no signer to key on before that, so it cannot be
 * middleware, and a new route silently gets no budget. That is a real hazard,
 * not a theoretical one: `/buffer-balance` landed on main while this work was
 * in flight, authenticated but with no budget check.
 *
 * A route added or removed fails this test. Add it here together with its
 * `enforceSignerLimit` call.
 */
const EXPECTED_ROUTES = [
	"DELETE /proposal/:id",
	"GET /healthz",
	"GET /proposal/:id",
	"GET /proposals/:orderUid",
	"GET /proposals/by-sub-solver",
	"POST /proposals",
].sort();

function publicRoutes(): string[] {
	const ctx: PublicAppContext = {
		// biome-ignore lint/suspicious/noExplicitAny: the routes are registered without touching the db
		db: {} as any,
		chainId: 1,
		trampolineFactory: "0x00000000000000000000000000000000000fac70" as Address,
		maxProposalLifetimeSecs: 300,
		gasPriceRef: { value: 0n },
		onAuditEvent: () => {},
		rateLimits: {
			windowSecs: 60,
			ipPerWindow: 6000,
			tier: { rateUnitWei: 10n ** 17n, ratePerUnit: 300, minRate: 120, maxRate: 3000 },
			floorWei: 10n ** 16n,
		},
	};

	const app = createPublicApp(ctx);
	return [
		...new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`)),
	].sort();
}

describe("public route inventory", () => {
	it("has no route that nobody decided about", () => {
		expect(publicRoutes()).toEqual(EXPECTED_ROUTES);
	});

	it("exempts only the liveness probe from the per-IP backstop", () => {
		// Mirrors the exemptPaths list in createPublicApp. Anything else added
		// there is a route that stops being rate limited.
		expect(EXPECTED_ROUTES.filter((r) => r.endsWith("/healthz"))).toEqual(["GET /healthz"]);
	});
});
