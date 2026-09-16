import { acceptAll } from "@byos/byos/src/domain/validator.js";
import { runProposalValidation } from "@byos/byos/src/infra/jobs/validation.js";
import * as store from "@byos/byos/src/infra/storage.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signAndSubmitProposal, type TestApp } from "./helpers.js";

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as any;

describe("immediate proposal validation on POST /proposals", () => {
	let app: TestApp;

	beforeEach(async () => {
		app = await createTestApp();
	});

	afterEach(async () => {
		await app.ctx.cleanup();
	});

	it("triggers immediate validation when a proposal is accepted", async () => {
		const triggered: number[] = [];
		app = await createTestApp({
			runImmediateValidation: async (id) => {
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

	it("proposal becomes active after immediate validation runs", async () => {
		app = await createTestApp({
			runImmediateValidation: (proposalId) =>
				runProposalValidation(
					{ db: app.ctx.db, validator: acceptAll, onAuditEvent: () => {}, logger },
					proposalId,
				),
		});

		const { response } = await signAndSubmitProposal(app.publicApp);
		expect(response.status).toBe(202);

		// Give the fire-and-forget a tick to complete
		await new Promise((resolve) => setTimeout(resolve, 50));

		const { id } = (await response.json()) as { id: number };
		const proposal = await store.get(app.ctx.db, id);
		expect(proposal?.status).toBe("active");
	});

	it("does not trigger immediate validation for a duplicate proposal (nonce conflict)", async () => {
		const triggered: number[] = [];
		app = await createTestApp({
			runImmediateValidation: async (id) => {
				triggered.push(id);
			},
		});

		// Submit same proposal twice (same nonce)
		const { response: r1 } = await signAndSubmitProposal(app.publicApp, { nonce: 42n });
		const { response: r2 } = await signAndSubmitProposal(app.publicApp, { nonce: 42n });

		expect(r1.status).toBe(202);
		expect(r2.status).toBe(202);

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Both return the same id (idempotent), validation triggered once
		const { id: id1 } = (await r1.json()) as { id: number };
		const { id: id2 } = (await r2.json()) as { id: number };
		expect(id1).toBe(id2);
		expect(triggered.length).toBe(1);
	});
});
