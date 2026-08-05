import * as store from "@byos/byos/src/infra/storage.js";
import type { Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, signAndSubmitProposal, type TestApp } from "./helpers.js";

let app: TestApp;

beforeAll(async () => {
	app = await createTestApp();
});

afterAll(async () => {
	await app.ctx.cleanup();
});

async function postNotify(body: unknown): Promise<{ status: number; body: unknown }> {
	const resp = await app.internalApp.request("/notify", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: resp.status, body: await resp.json() };
}

async function seedActiveProposal(nonce: bigint): Promise<number> {
	const { response } = await signAndSubmitProposal(app.publicApp, { nonce });
	const { id } = await response.json();

	// Transition to active
	await store.resolveVerdict(app.ctx.db, id, {
		kind: "accept",
		simulation: {
			gasUsed: 150_000n,
			trampoline: "0x0000000000000000000000000000000000001234" as Address,
			sellToken: "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1" as Address,
			buyToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
		},
	});

	return id;
}

describe("/notify", () => {
	it("always returns 200 (fire-and-forget)", async () => {
		const { status } = await postNotify({
			auctionId: "999",
			solutionId: 1,
			kind: "success",
			transaction: `0x${"aa".repeat(32)}`,
		});
		expect(status).toBe(200);
	});

	it("success notification transitions to settled", async () => {
		const id = await seedActiveProposal(300n);

		// Record solution attribution
		await store.recordSolution(app.ctx.db, 100, 1, id);

		// Move to executing
		const proposal = (await store.get(app.ctx.db, id))!;
		await store.applySettlementOutcome(app.ctx.db, proposal, { kind: "started" });

		// Notify success
		const txHash = `0x${"bb".repeat(32)}`;
		await postNotify({
			auctionId: "100",
			solutionId: 1,
			kind: "success",
			transaction: txHash,
		});

		const updated = await store.get(app.ctx.db, id);
		expect(updated?.status).toBe("settled");
	});

	it("revert notification transitions to settleFailed", async () => {
		const id = await seedActiveProposal(301n);
		await store.recordSolution(app.ctx.db, 101, 1, id);

		const proposal = (await store.get(app.ctx.db, id))!;
		await store.applySettlementOutcome(app.ctx.db, proposal, { kind: "started" });

		const txHash = `0x${"cc".repeat(32)}`;
		await postNotify({
			auctionId: "101",
			solutionId: 1,
			kind: "revert",
			transaction: txHash,
		});

		const updated = await store.get(app.ctx.db, id);
		expect(updated?.status).toBe("settleFailed");
	});

	it("unknown kind returns 200 with no state change", async () => {
		const { status } = await postNotify({
			auctionId: "999",
			solutionId: 99,
			kind: "someUnknownPreSubmissionKind",
		});
		expect(status).toBe(200);
	});
});
