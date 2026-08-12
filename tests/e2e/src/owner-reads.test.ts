// Ported from the Rust public-router tests (byos infra/api/mod.rs): what an
// owner sees on the wire through a proposal's later lifecycle, and the
// owner-scoping ADR-0011 promises.
import * as store from "@byos/byos/src/infra/storage.js";
import { type ContractInteraction, computeInteractionsHash } from "@byos/common";
import type { Address, Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cancelSignatureHeader,
	createTestApp,
	readAuthHeader,
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

async function ownerGet(id: number): Promise<{ status: number; body: any }> {
	const sig = await readAuthHeader();
	const resp = await app.publicApp.request(`/proposal/${id}`, {
		headers: { "X-Signature": sig },
	});
	return { status: resp.status, body: await resp.json() };
}

async function submitAndReject(
	nonce: bigint,
	reason: "InsufficientEscrow" | "Unprofitable",
): Promise<number> {
	const { response } = await signAndSubmitProposal(app.publicApp, { nonce });
	const { id } = await response.json();
	await store.resolveVerdict(app.ctx.db, id, { kind: "reject", reason });
	return id;
}

describe("owner-scoped reads", () => {
	it("rejected proposal exposes reason on the wire", async () => {
		const id = await submitAndReject(601n, "InsufficientEscrow");
		const { status, body } = await ownerGet(id);
		expect(status).toBe(200);
		expect(body.status).toBe("rejected");
		expect(body.rejectionReason).toBe("InsufficientEscrow");
	});

	it("unprofitable rejection exposes reason on the wire", async () => {
		const id = await submitAndReject(602n, "Unprofitable");
		const { body } = await ownerGet(id);
		expect(body.status).toBe("rejected");
		expect(body.rejectionReason).toBe("Unprofitable");
	});

	it("owner reads own amounts back", async () => {
		const { response } = await signAndSubmitProposal(app.publicApp, { nonce: 603n });
		const { id } = await response.json();
		const { status, body } = await ownerGet(id);
		expect(status).toBe(200);
		expect(body.id).toBe(id);
		expect(body.sellAmount).toBe("1000000");
		expect(body.buyAmount).toBe("990000");
	});

	// Once the debit lands, the owner's GET shows penalized and cites the
	// debit tx — with the reverted settlement still cited alongside it.
	it("penalized proposal exposes the penalty tx on owner GET", async () => {
		const settlementTx = `0x${"22".repeat(32)}` as Hex;
		const penaltyTx = `0x${"77".repeat(32)}` as Hex;
		const id = await seedProposal(app.ctx.db, {
			orderUid: `0x${"d1".repeat(56)}`,
			subSolver: SIGNER_ACCOUNT.address,
			status: "settleFailed",
			settlementTxHash: settlementTx,
		});
		const stored = await store.get(app.ctx.db, id);
		expect(stored).not.toBeNull();
		await store.recordPenalty(app.ctx.db, stored!, 16_000_000_000_000_000n, penaltyTx);

		const { status, body } = await ownerGet(id);
		expect(status).toBe(200);
		expect(body.status).toBe("penalized");
		expect(body.penaltyTxHash).toBe(penaltyTx);
		expect(body.settlementTxHash, "the reverted settlement stays cited alongside the debit").toBe(
			settlementTx,
		);
	});

	// A settlement is in flight — the cancellation is deferred until the
	// settlement outcome lands.
	it("cancel of an executing proposal is deferred", async () => {
		const id = await seedProposal(app.ctx.db, {
			orderUid: `0x${"d2".repeat(56)}`,
			subSolver: SIGNER_ACCOUNT.address,
			status: "executing",
		});

		const sig = await cancelSignatureHeader(id);
		const resp = await app.publicApp.request(`/proposal/${id}`, {
			method: "DELETE",
			headers: { "X-Signature": sig },
		});
		expect(resp.status).toBe(202);

		const stored = await store.get(app.ctx.db, id);
		expect(stored?.status, "the in-flight settlement keeps its proposal").toBe("executing");
		expect(stored?.pendingCancellation, "cancellation is deferred").toBe(true);
	});

	it("list by order uid is scoped to the caller", async () => {
		const orderUid = `0x${"d3".repeat(56)}`;
		await seedProposal(app.ctx.db, { orderUid, subSolver: SIGNER_ACCOUNT.address });
		await seedProposal(app.ctx.db, {
			orderUid,
			subSolver: "0x0202020202020202020202020202020202020202" as Address,
		});

		const sig = await readAuthHeader();
		const resp = await app.publicApp.request(`/proposals/${orderUid}`, {
			headers: { "X-Signature": sig },
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.proposals, "competitor's proposal must not leak").toHaveLength(1);
		expect(body.proposals[0].subSolver.toLowerCase()).toBe(SIGNER_ACCOUNT.address.toLowerCase());
	});

	// The signature covers the interactions hash, so a route that survives
	// the round trip byte-for-byte is also evidence that recovery ran over
	// the same list the sub-solver signed.
	it("a proposal carrying a route is accepted and stored intact", async () => {
		const route: ContractInteraction[] = [
			{
				target: `0x${"33".repeat(20)}` as Address,
				value: 0n,
				callData: "0x095ea7b3deadbeef" as Hex,
			},
			{
				target: `0x${"44".repeat(20)}` as Address,
				value: 7n,
				callData: "0x128acb08cafe" as Hex,
			},
		];
		const { response } = await signAndSubmitProposal(app.publicApp, {
			nonce: 604n,
			interactions: route,
		});
		expect(response.status).toBe(202);
		const { id } = await response.json();

		const stored = await store.get(app.ctx.db, id);
		expect(stored).not.toBeNull();
		expect(
			stored?.interactions.map((i) => ({ ...i, target: i.target.toLowerCase() })),
			"the stored route must match the signed one exactly",
		).toEqual(route);
		expect(
			stored?.interactionsHash,
			"the hash recovery ran over must be the hash of this route",
		).toBe(computeInteractionsHash(route));
	});
});
