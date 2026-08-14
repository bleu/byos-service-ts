import * as store from "@byos/byos/src/infra/storage.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cancelSignatureHeader,
	createTestApp,
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

describe("cancel edge cases", () => {
	it("double cancel returns 409 with terminal status description", async () => {
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
		expect(resp2.status).toBe(409);
		const body = await resp2.json();
		expect(body.kind).toBe("ProposalNotCancellable");
		expect(body.description).toContain("cancelled");
	});

	it("cancel of executing proposal returns 202 with deferred status", async () => {
		const { response } = await signAndSubmitProposal(app.publicApp, { nonce: 303n });
		const { id } = await response.json();

		// Drive proposal to executing: submitted → active → executing
		const submitted = (await store.get(app.ctx.db, id))!;
		await store.transition(app.ctx.db, submitted, "active");
		const active = (await store.get(app.ctx.db, id))!;
		await store.applySettlementOutcome(app.ctx.db, active, { kind: "started" });

		const sig = await cancelSignatureHeader(id);
		const resp = await app.publicApp.request(`/proposal/${id}`, {
			method: "DELETE",
			headers: { "X-Signature": sig },
		});
		expect(resp.status).toBe(202);
		const body = await resp.json();
		expect(body.status).toBe("pending");
		expect(body.description).toContain("settlement");
	});

	it("deferred cancel transitions to cancelled when settlement is abandoned", async () => {
		const { response } = await signAndSubmitProposal(app.publicApp, { nonce: 304n });
		const { id } = await response.json();

		// Drive to executing
		const submitted = (await store.get(app.ctx.db, id))!;
		await store.transition(app.ctx.db, submitted, "active");
		const active = (await store.get(app.ctx.db, id))!;
		await store.applySettlementOutcome(app.ctx.db, active, { kind: "started" });

		// Cancel while executing (deferred)
		const sig = await cancelSignatureHeader(id);
		const cancelResp = await app.publicApp.request(`/proposal/${id}`, {
			method: "DELETE",
			headers: { "X-Signature": sig },
		});
		expect(cancelResp.status).toBe(202);

		// Settlement abandoned → should transition to cancelled, not active
		const executing = (await store.get(app.ctx.db, id))!;
		await store.applySettlementOutcome(app.ctx.db, executing, { kind: "abandoned" });

		const final = await store.get(app.ctx.db, id);
		expect(final?.status).toBe("cancelled");
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
		expect(response.status).toBe(202);
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
				maxBuyAmount: "900",
				interactions: [],
				validUntil: String(Math.floor(Date.now() / 1000) + 200),
				nonce: "1",
				signature: "0x" + "ab".repeat(65),
			}),
		});
		expect(resp.status).toBe(400);
	});
});
