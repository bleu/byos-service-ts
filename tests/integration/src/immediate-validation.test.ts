import { acceptAll } from "@byos/byos/src/domain/validator.js";
import { runProposalValidation } from "@byos/byos/src/infra/jobs/validation.js";
import * as store from "@byos/byos/src/infra/storage.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signAndSubmitProposal, type TestApp } from "./helpers.js";

const logger = {
	info: () => {},
	warn: () => {},
	debug: () => {},
	error: () => {},
} as unknown as Parameters<typeof runProposalValidation>[0]["logger"];

describe("validation dispatch on POST /proposals", () => {
	let app: TestApp;

	beforeEach(async () => {
		app = await createTestApp();
	});

	afterEach(async () => {
		await app.ctx.cleanup();
	});

	it("dispatches validation when a proposal is accepted", async () => {
		const triggered: number[] = [];
		await app.ctx.cleanup();
		app = await createTestApp({
			enqueueValidation: async (id) => {
				triggered.push(id);
			},
		});

		const { response } = await signAndSubmitProposal(app.publicApp);
		expect(response.status).toBe(202);

		// Give the fire-and-forget a tick to run
		await new Promise((resolve) => setTimeout(resolve, 10));

		const { id } = (await response.json()) as { id: number };
		expect(triggered).toContain(id);
	});

	it("proposal remains submitted until the dispatched validation runs", async () => {
		const queued: number[] = [];
		await app.ctx.cleanup();
		app = await createTestApp({
			enqueueValidation: async (id) => {
				queued.push(id);
			},
		});

		const { response } = await signAndSubmitProposal(app.publicApp);
		expect(response.status).toBe(202);

		// Give the fire-and-forget a tick to complete
		await new Promise((resolve) => setTimeout(resolve, 50));

		const { id } = (await response.json()) as { id: number };
		const proposal = await store.get(app.ctx.db, id);
		expect(proposal?.status).toBe("submitted");
		expect(queued).toEqual([id]);
		await runProposalValidation(
			{ db: app.ctx.db, validator: acceptAll, onAuditEvent: () => {}, logger },
			id,
		);
		expect((await store.get(app.ctx.db, id))?.status).toBe("active");
	});

	it("does not dispatch validation for a duplicate proposal (nonce conflict)", async () => {
		const triggered: number[] = [];
		await app.ctx.cleanup();
		app = await createTestApp({
			enqueueValidation: async (id) => {
				triggered.push(id);
			},
		});

		// Submit same proposal twice (same nonce)
		const { response: r1, body } = await signAndSubmitProposal(app.publicApp, { nonce: 42n });
		const r2 = await app.publicApp.request("/proposals", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		expect(r1.status).toBe(202);
		expect(r2.status).toBe(202);

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Both return the same id (idempotent), validation triggered once
		const { id: id1 } = (await r1.json()) as { id: number };
		const { id: id2 } = (await r2.json()) as { id: number };
		expect(id1).toBe(id2);
		expect(triggered.length).toBe(1);
	});

	it("keeps the submission available for the tick when enqueueing fails", async () => {
		await app.ctx.cleanup();
		app = await createTestApp({
			enqueueValidation: async () => {
				throw new Error("Redis unavailable");
			},
		});
		const { response } = await signAndSubmitProposal(app.publicApp);
		expect(response.status).toBe(202);
		const { id } = (await response.json()) as { id: number };
		expect((await store.get(app.ctx.db, id))?.status).toBe("submitted");
		await runProposalValidation(
			{ db: app.ctx.db, validator: acceptAll, onAuditEvent: () => {}, logger },
			id,
		);
		expect((await store.get(app.ctx.db, id))?.status).toBe("active");
	});
});
