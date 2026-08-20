import type { BalanceCache, CachedBalance } from "@byos/byos/src/domain/balance-cache.js";
import type { LimitDecision, RateLimiter } from "@byos/byos/src/domain/rate-limit.js";
import type { Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import {
	cancelSignatureHeader,
	createTestApp,
	readAuthHeader,
	SIGNER_ACCOUNT,
	seedProposal,
	signAndSubmitProposal,
	type TestApp,
} from "./helpers.js";

interface RecordingLimiter extends RateLimiter {
	/** Keys seen at the given layer, in order. */
	keysFor(layer: "signer" | "ip"): string[];
	/** Budgets the routes asked for at the given layer, in order. */
	limitsFor(layer: "signer" | "ip"): number[];
}

/**
 * One limiter serves both layers in production, so the fake does too. Each
 * layer gets its own allowance; anything left unset is unlimited.
 */
function budgets(caps: { signer?: number; ip?: number } = {}): RecordingLimiter {
	const seen: { key: string; limit: number }[] = [];
	const spent = new Map<string, number>();

	const at = (layer: "signer" | "ip") => seen.filter((s) => s.key.startsWith(`${layer}:`));

	return {
		keysFor: (layer) => at(layer).map((s) => s.key),
		limitsFor: (layer) => at(layer).map((s) => s.limit),
		async checkLimit(key, limit): Promise<LimitDecision> {
			seen.push({ key, limit });
			const count = (spent.get(key) ?? 0) + 1;
			spent.set(key, count);
			const cap = key.startsWith("signer:") ? (caps.signer ?? Infinity) : (caps.ip ?? Infinity);
			return { allowed: count <= cap, remaining: Math.max(0, cap - count), resetAt: 42 };
		},
	};
}

function balancesOf(balance: CachedBalance): BalanceCache {
	return {
		async lookup(): Promise<CachedBalance> {
			return balance;
		},
	};
}

let app: TestApp;
afterEach(async () => {
	await app?.ctx.cleanup();
});

const uid = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(56)}` as Hex;

describe("per-signer rate limiting", () => {
	it("rejects a sub-solver past its budget with 429", async () => {
		const limiter = budgets({ signer: 1 });
		app = await createTestApp({ rateLimiter: limiter });

		const first = await signAndSubmitProposal(app.publicApp, { orderUid: uid(1), nonce: 1n });
		expect(first.response.status).toBe(202);

		const second = await signAndSubmitProposal(app.publicApp, { orderUid: uid(2), nonce: 2n });
		expect(second.response.status).toBe(429);
		expect(second.response.headers.get("Retry-After")).toBeTruthy();
		await expect(second.response.json()).resolves.toMatchObject({ kind: "RateLimited" });
	});

	it("spends one budget across every authenticated route", async () => {
		// One key per request, whatever the verb or path. A route that skips
		// enforceSignerLimit is a free polling channel, which is how
		// /buffer-balance arrived: signature authenticated, budget unmetered.
		const limiter = budgets();
		app = await createTestApp({ rateLimiter: limiter });

		const { response } = await signAndSubmitProposal(app.publicApp, { orderUid: uid(3) });
		const { id } = (await response.json()) as { id: number };

		const readAuth = { "X-Signature": await readAuthHeader() };
		await app.publicApp.request(`/proposal/${id}`, { headers: readAuth });
		await app.publicApp.request("/proposals/by-sub-solver", { headers: readAuth });
		await app.publicApp.request("/buffer-balance", { headers: readAuth });
		await app.publicApp.request(`/proposal/${id}`, {
			method: "DELETE",
			headers: { "X-Signature": await cancelSignatureHeader(id) },
		});

		const expected = `signer:${SIGNER_ACCOUNT.address.toLowerCase()}`;
		expect(limiter.keysFor("signer")).toEqual(Array(5).fill(expected));
	});

	it("sizes the budget from the signer's escrow balance", async () => {
		const limiter = budgets();
		app = await createTestApp({
			rateLimiter: limiter,
			balances: balancesOf(3n * 10n ** 17n),
		});

		await signAndSubmitProposal(app.publicApp, { orderUid: uid(4) });

		expect(limiter.limitsFor("signer")).toEqual([900]);
	});

	it("admits a never-seen sub-solver at the lowest tier", async () => {
		const limiter = budgets();
		app = await createTestApp({ rateLimiter: limiter, balances: balancesOf("unknown") });

		const { response } = await signAndSubmitProposal(app.publicApp, { orderUid: uid(5) });

		expect(response.status).toBe(202);
		expect(limiter.limitsFor("signer")).toEqual([120]);
	});

	it("rejects a sub-solver known to be below the escrow floor with 403", async () => {
		app = await createTestApp({ balances: balancesOf(1n) });

		const { response } = await signAndSubmitProposal(app.publicApp, { orderUid: uid(6) });

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toMatchObject({ kind: "InsufficientEscrow" });
	});

	it("still lets an underfunded sub-solver read and cancel what it has live", async () => {
		// effectiveBalance reads zero from the moment requestWithdrawal() is
		// called, so a floor gate on every verb would strand a winding-down
		// sub-solver: unable to cancel its live proposals, and blind to them.
		app = await createTestApp({ balances: balancesOf(1n) });
		const id = await seedProposal(app.ctx.db, {
			orderUid: uid(8),
			subSolver: SIGNER_ACCOUNT.address,
		});

		const read = await app.publicApp.request(`/proposal/${id}`, {
			headers: { "X-Signature": await readAuthHeader() },
		});
		expect(read.status).toBe(200);

		const cancelled = await app.publicApp.request(`/proposal/${id}`, {
			method: "DELETE",
			headers: { "X-Signature": await cancelSignatureHeader(id) },
		});
		expect(cancelled.status).toBe(204);
	});

	it("answers 503, not 429, when the limiter's store is down", async () => {
		app = await createTestApp({
			rateLimiter: {
				async checkLimit(): Promise<LimitDecision> {
					throw new Error("ECONNREFUSED");
				},
			},
		});

		const { response } = await signAndSubmitProposal(app.publicApp, { orderUid: uid(7) });

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({ kind: "ServiceUnavailable" });
	});
});

describe("ip backstop", () => {
	it("sheds a flooding IP before any signature recovery", async () => {
		const limiter = budgets({ ip: 0 });
		app = await createTestApp({ rateLimiter: limiter, ipLimit: 10 });

		const res = await app.publicApp.request("/proposals", {
			method: "POST",
			headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(429);
		// Keyed on the IP, and reached before the body was parsed or a
		// signature recovered — no signer budget was ever consulted.
		expect(limiter.keysFor("ip")).toEqual(["ip:203.0.113.7"]);
		expect(limiter.keysFor("signer")).toEqual([]);
	});

	it("leaves the internal listener unlimited, since it is driver-facing", async () => {
		const limiter = budgets({ ip: 0 });
		app = await createTestApp({ rateLimiter: limiter, ipLimit: 10 });

		const res = await app.internalApp.request("/healthz");

		expect(res.status).toBe(200);
		expect(limiter.keysFor("ip")).toEqual([]);
	});
});
