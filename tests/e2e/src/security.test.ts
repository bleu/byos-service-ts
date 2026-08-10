import { createInternalApp } from "@byos/byos/src/infra/api/index.js";
import { createTestDb } from "@byos/byos/test/setup.js";
import { signCancellation } from "@byos/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	CHAIN_ID,
	createTestApp,
	DOMAIN,
	MAX_PROPOSAL_LIFETIME_SECS,
	OTHER_SIGN_FN,
	signAndSubmitProposal,
	type TestApp,
	TRAMPOLINE_FACTORY,
} from "./helpers.js";

let app: TestApp;

beforeAll(async () => {
	app = await createTestApp();
});

afterAll(async () => {
	await app.ctx.cleanup();
});

describe("listener isolation", () => {
	it("POST /solve is not reachable on public listener", async () => {
		const resp = await app.publicApp.request("/solve", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: "1", orders: [], tokens: {} }),
		});
		expect(resp.status).toBe(404);
	});

	it("POST /proposals is not reachable on internal listener", async () => {
		const resp = await app.internalApp.request("/proposals", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(404);
	});
});

describe("bearer token enforcement", () => {
	it("POST /solve without bearer token returns 401 when configured", async () => {
		const ctx = await createTestDb();
		try {
			const auditEvents: unknown[] = [];
			const appCtx = {
				db: ctx.db,
				chainId: CHAIN_ID,
				trampolineFactory: TRAMPOLINE_FACTORY,
				maxProposalLifetimeSecs: MAX_PROPOSAL_LIFETIME_SECS,
				gasPriceRef: { value: 10_000_000_000n },
				solveBearerToken: "test-secret",
				onAuditEvent: (e: unknown) => auditEvents.push(e),
			};

			const authedApp = createInternalApp(appCtx);

			// Without Authorization header → 401
			const noAuthResp = await authedApp.request("/solve", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					id: "1",
					orders: [],
					tokens: {},
					effectiveGasPrice: "10000000000",
					deadline: "2099-01-01T00:00:00Z",
				}),
			});
			expect(noAuthResp.status).toBe(401);

			// With correct Authorization header → 200
			const authedResp = await authedApp.request("/solve", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-secret",
				},
				body: JSON.stringify({
					id: "1",
					orders: [],
					tokens: {},
					effectiveGasPrice: "10000000000",
					deadline: "2099-01-01T00:00:00Z",
				}),
			});
			expect(authedResp.status).toBe(200);
		} finally {
			await ctx.cleanup();
		}
	});
});

describe("auth rejection", () => {
	it("GET /proposal/:id without X-Signature is rejected", async () => {
		const { response } = await signAndSubmitProposal(app.publicApp);
		const { id } = await response.json();

		const resp = await app.publicApp.request(`/proposal/${id}`);
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.kind).toBe("BadRequest");
	});

	it("GET /proposals/by-sub-solver without X-Signature is rejected", async () => {
		const resp = await app.publicApp.request("/proposals/by-sub-solver");
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.kind).toBe("BadRequest");
	});

	it("GET /proposals/:orderUid without X-Signature is rejected", async () => {
		const resp = await app.publicApp.request(`/proposals/0x${"ab".repeat(56)}`);
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.kind).toBe("BadRequest");
	});

	it("DELETE /proposal/:id by non-owner returns 404 (not 403)", async () => {
		// Submit proposal with default SIGNER_ACCOUNT
		const { response } = await signAndSubmitProposal(app.publicApp);
		const { id } = await response.json();

		// Sign cancellation as a different user
		const otherSig = await signCancellation(OTHER_SIGN_FN, DOMAIN, BigInt(id));

		const cancelResp = await app.publicApp.request(`/proposal/${id}`, {
			method: "DELETE",
			headers: { "X-Signature": otherSig },
		});

		// Should return 404 (privacy: no existence oracle, per ADR-0011)
		expect(cancelResp.status).toBe(404);
		const body = await cancelResp.json();
		expect(body.kind).toBe("ProposalNotFound");
	});
});
