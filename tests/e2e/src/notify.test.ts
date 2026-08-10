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

	// Ported from Rust upstream_notification_shapes_deserialize: every shape
	// the driver actually sends must be accepted; unknown kinds and flattened
	// kind-specific fields must not 4xx/5xx the driver.
	it("upstream notification shapes are accepted", async () => {
		const bodies = [
			{ auctionId: "1234", solutionId: 1, kind: "settlementStarted" },
			{
				auctionId: "1234",
				solutionId: [1, 2],
				kind: "success",
				transaction: `0x${"ab".repeat(32)}`,
			},
			// Pre-solution kinds fire with no ids at all.
			{ kind: "deserializationError", reason: "bad json" },
			{ auctionId: null, solutionId: null, kind: "timeout" },
			// Flattened kind-specific fields must be tolerated, not rejected.
			{ auctionId: "9", solutionId: 3, kind: "simulationFailed", block: 123, succeededOnce: false },
			// Kinds added upstream after this code shipped.
			{ auctionId: "9", solutionId: 3, kind: "someFutureKind" },
		];
		for (const body of bodies) {
			const { status } = await postNotify(body);
			expect(status, `must accept ${JSON.stringify(body)}`).toBe(200);
		}
	});

	it("malformed transaction hash is rejected and nothing is persisted", async () => {
		const id = await seedActiveProposal(303n);
		await store.recordSolution(app.ctx.db, 103, 1, id);
		const proposal = (await store.get(app.ctx.db, id))!;
		await store.applySettlementOutcome(app.ctx.db, proposal, { kind: "started" });

		const { status } = await postNotify({
			auctionId: "103",
			solutionId: 1,
			kind: "success",
			transaction: "0xzz",
		});
		expect(status).toBe(400);

		const updated = await store.get(app.ctx.db, id);
		expect(updated?.status).toBe("executing");
		expect(updated?.settlementTxHash).toBeNull();
	});

	it("missing kind is rejected", async () => {
		const { status } = await postNotify({ auctionId: "999", solutionId: 1 });
		expect(status).toBe(400);
	});
});
