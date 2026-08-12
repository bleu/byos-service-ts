import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cancelSignatureHeader,
	createTestApp,
	OTHER_SIGNER_ACCOUNT,
	otherReadAuthHeader,
	readAuthHeader,
	signAndSubmitProposal,
	type TestApp,
} from "./helpers.js";

let app: TestApp;

beforeAll(async () => {
	app = await createTestApp();
});

afterAll(async () => {
	await app.ctx.cleanup();
});

describe("proposal lifecycle", () => {
	it("submits a valid proposal → 202", async () => {
		const { response } = await signAndSubmitProposal(app.publicApp);
		expect(response.status).toBe(202);
		const body = await response.json();
		expect(body.id).toBeGreaterThan(0);
	});

	it("rejects expired proposal → 400", async () => {
		const { response } = await signAndSubmitProposal(app.publicApp, {
			validUntil: 1n, // far in the past
		});
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.kind).toBe("ProposalExpired");
	});

	it("rejects proposal exceeding lifetime cap → 400", async () => {
		const now = BigInt(Math.floor(Date.now() / 1000));
		const { response } = await signAndSubmitProposal(app.publicApp, {
			validUntil: now + 10_000n, // exceeds 300s cap
		});
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.kind).toBe("ProposalLifetimeExceeded");
	});

	it("gets proposal by id (owner) → 200", async () => {
		const { response: createResp } = await signAndSubmitProposal(app.publicApp);
		const { id } = await createResp.json();

		const sig = await readAuthHeader();
		const getResp = await app.publicApp.request(`/proposal/${id}`, {
			headers: { "X-Signature": sig },
		});

		expect(getResp.status).toBe(200);
		const body = await getResp.json();
		expect(body.id).toBe(id);
		expect(body.status).toBe("submitted");
	});

	it("gets proposal by non-owner → 404", async () => {
		const { response: createResp } = await signAndSubmitProposal(app.publicApp);
		const { id } = await createResp.json();

		const sig = await otherReadAuthHeader();
		const getResp = await app.publicApp.request(`/proposal/${id}`, {
			headers: { "X-Signature": sig },
		});

		expect(getResp.status).toBe(404);
	});

	it("lists proposals by sub-solver", async () => {
		await signAndSubmitProposal(app.publicApp, { nonce: 100n });

		const sig = await readAuthHeader();
		const listResp = await app.publicApp.request("/proposals/by-sub-solver", {
			headers: { "X-Signature": sig },
		});

		expect(listResp.status).toBe(200);
		const body = await listResp.json();
		expect(body.proposals.length).toBeGreaterThanOrEqual(1);
	});

	it("cancels a submitted proposal → 204", async () => {
		const { response: createResp } = await signAndSubmitProposal(app.publicApp, { nonce: 200n });
		const { id } = await createResp.json();

		const sig = await cancelSignatureHeader(id);
		const cancelResp = await app.publicApp.request(`/proposal/${id}`, {
			method: "DELETE",
			headers: { "X-Signature": sig },
		});

		expect(cancelResp.status).toBe(204);

		// Verify it's cancelled
		const readSig = await readAuthHeader();
		const getResp = await app.publicApp.request(`/proposal/${id}`, {
			headers: { "X-Signature": readSig },
		});
		const body = await getResp.json();
		expect(body.status).toBe("cancelled");
	});

	it("unknown orderUid returns empty list", async () => {
		const sig = await readAuthHeader();
		const resp = await app.publicApp.request("/proposals/0x" + "ff".repeat(56), {
			headers: { "X-Signature": sig },
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.proposals).toHaveLength(0);
	});

	it("listing by sub-solver is identity-scoped", async () => {
		// Submit a proposal with SIGNER
		await signAndSubmitProposal(app.publicApp, { nonce: 401n });

		// List as SIGNER → should find it
		const signerSig = await readAuthHeader();
		const signerResp = await app.publicApp.request("/proposals/by-sub-solver", {
			headers: { "X-Signature": signerSig },
		});
		const signerBody = await signerResp.json();
		expect(signerBody.proposals.length).toBeGreaterThanOrEqual(1);

		// List as OTHER_SIGNER → should not find it
		const otherSig = await otherReadAuthHeader();
		const otherResp = await app.publicApp.request("/proposals/by-sub-solver", {
			headers: { "X-Signature": otherSig },
		});
		const otherBody = await otherResp.json();
		// Other signer should not see SIGNER's proposals
		// (they might have their own, but shouldn't see ours)
		const ourProposals = otherBody.proposals.filter(
			(p: any) => p.subSolver?.toLowerCase() !== OTHER_SIGNER_ACCOUNT.address.toLowerCase(),
		);
		expect(ourProposals).toHaveLength(0);
	});

	it("healthz returns 200", async () => {
		const resp = await app.publicApp.request("/healthz");
		expect(resp.status).toBe(200);
	});
});
