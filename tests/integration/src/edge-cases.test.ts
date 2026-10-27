import type { Proposal } from "@byos/byos/src/domain/proposal.js";
import * as store from "@byos/byos/src/infra/storage.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cancelSignatureHeader,
	createTestApp,
	SIGNER_ACCOUNT,
	seedProposal,
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

async function getProposal(id: number): Promise<Proposal> {
	const proposal = await store.get(app.ctx.db, id);
	if (!proposal) throw new Error(`proposal ${id} missing`);
	return proposal;
}

describe("cancel edge cases", () => {
	it("double cancel returns 404 after the candidate is removed", async () => {
		const { response } = await signAndSubmitProposal(app.publicApp, { nonce: 301n });
		const { id } = await response.json();

		const sig = await cancelSignatureHeader(id);
		// First cancel succeeds
		const resp1 = await app.publicApp.request(`/proposal/${id}`, {
			method: "DELETE",
			headers: { "X-Signature": sig },
		});
		expect(resp1.status).toBe(204);

		// Second cancel returns 409 (terminal state)
		const resp2 = await app.publicApp.request(`/proposal/${id}`, {
			method: "DELETE",
			headers: { "X-Signature": sig },
		});
		expect(resp2.status).toBe(404);
		const body = await resp2.json();
		expect(body.kind).toBe("ProposalNotFound");
	});

	it("submitted bids cannot be cancelled, even before settlement starts", async () => {
		const id = await seedProposal(app.ctx.db, {
			orderUid: `0x${"b1".repeat(56)}`,
			subSolver: SIGNER_ACCOUNT.address,
		});
		const resp = await app.publicApp.request(`/proposal/${id}`, {
			method: "DELETE",
			headers: { "X-Signature": await cancelSignatureHeader(id) },
		});
		expect(resp.status).toBe(409);
		expect((await resp.json()).kind).toBe("ProposalNotCancellable");
		expect((await getProposal(id)).status).toBe("submitted");
	});
	it("abandoned bids are logged as lost and cannot be cancelled", async () => {
		const id = await seedProposal(app.ctx.db, {
			orderUid: `0x${"b2".repeat(56)}`,
			subSolver: SIGNER_ACCOUNT.address,
		});
		await store.applySettlementOutcome(app.ctx.db, await getProposal(id), { kind: "abandoned" });
		expect(await store.get(app.ctx.db, id)).toBeNull();
		expect((await store.getIncludingLog(app.ctx.db, id))?.status).toBe("lost");
		const resp = await app.publicApp.request(`/proposal/${id}`, {
			method: "DELETE",
			headers: { "X-Signature": await cancelSignatureHeader(id) },
		});
		expect(resp.status).toBe(404);
	});

	it("cancel unknown id returns 404", async () => {
		const sig = await cancelSignatureHeader(999999);
		const resp = await app.publicApp.request("/proposal/999999", {
			method: "DELETE",
			headers: { "X-Signature": sig },
		});
		expect(resp.status).toBe(404);
	});

	it("accepts valid_until at the lifetime cap boundary", async () => {
		const now = BigInt(Math.floor(Date.now() / 1000));
		const { response } = await signAndSubmitProposal(app.publicApp, {
			validUntil: now + 300n, // exactly at the 300s cap
			nonce: 302n,
		});
		expect(response.status).toBe(200);
	});
});

describe("create proposal edge cases", () => {
	it("rejects empty orderUid", async () => {
		const resp = await app.publicApp.request("/proposals", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				orderUid: "",
				sellAmount: "1000",
				minBuyAmount: "900",
				quoteBuyAmount: "900",
				interactions: [],
				validUntil: String(Math.floor(Date.now() / 1000) + 200),
				nonce: "1",
				signature: `0x${"ab".repeat(65)}`,
			}),
		});
		expect(resp.status).toBe(400);
	});
});
