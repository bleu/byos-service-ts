import type { Proposal } from "@byos/byos/src/domain/proposal.js";
import * as store from "@byos/byos/src/infra/storage.js";
import type { Address, Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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

async function postNotify(body: unknown): Promise<{ status: number; body: unknown }> {
	const resp = await app.internalApp.request("/notify", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: resp.status, body: await resp.json() };
}

async function getProposal(id: number): Promise<Proposal> {
	const proposal = await store.get(app.ctx.db, id);
	if (!proposal) throw new Error(`proposal ${id} missing`);
	return proposal;
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
		const proposal = await getProposal(id);
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

		const proposal = await getProposal(id);
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

	it("attributable non-outcome kind changes nothing, kept as audit evidence", async () => {
		const id = await seedActiveProposal(302n);
		await store.recordSolution(app.ctx.db, 102, 1, id);

		const { status } = await postNotify({
			auctionId: "102",
			solutionId: 1,
			kind: "emptySolution",
		});
		expect(status).toBe(200);

		// Pre-submission kinds carry no transition (ADR-0013)
		const updated = await store.get(app.ctx.db, id);
		expect(updated?.status).toBe("active");

		// ...but the notification is kept as driverNotified evidence (ADR-0010)
		const evidence = app.auditEvents.filter(
			(e) => e.kind.type === "driverNotified" && e.kind.proposalId === id,
		);
		expect(evidence).toHaveLength(1);
		expect(evidence[0]?.kind).toMatchObject({ notificationKind: "emptySolution" });
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
		const proposal = await getProposal(id);
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

// Ported from the Rust notify tests (byos infra/api/notify.rs). Rust gives
// each test a fresh database; this suite shares one, so every test owns a
// distinct auction id and order UID, and penalty assertions filter by
// proposal id instead of counting globally.
describe("/notify settlement outcomes", () => {
	/** Rust's bid_proposal: a proposal in `status`, recorded as solution 1
	 * of `auctionId` — the state /notify finds after a won /solve round. */
	async function bidProposal(
		status: "active" | "executing",
		auctionId: number,
		uidByte: string,
		subSolver?: Address,
	): Promise<number> {
		const id = await seedProposal(app.ctx.db, {
			orderUid: `0x${uidByte.repeat(56)}`,
			status,
			...(subSolver ? { subSolver } : {}),
		});
		await store.recordSolution(app.ctx.db, auctionId, 1, id);
		return id;
	}

	async function penaltiesFor(id: number) {
		return (await store.pendingPenalties(app.ctx.db)).filter((p) => p.proposalId === id);
	}

	it("settlementStarted moves the won proposal to executing", async () => {
		const id = await bidProposal("active", 110, "c1");

		const { status } = await postNotify({
			auctionId: "110",
			solutionId: 1,
			kind: "settlementStarted",
		});
		expect(status).toBe(200);

		const updated = await store.get(app.ctx.db, id);
		expect(updated?.status).toBe("executing");
	});

	// cancelled/expired/fail mean no tx landed — the proposal returns to
	// Active and re-enters competition.
	it("abandoned submission returns the proposal to active", async () => {
		const cases = [
			{ kind: "cancelled", auctionId: 111, uidByte: "c2" },
			{ kind: "expired", auctionId: 112, uidByte: "c3" },
			{ kind: "fail", auctionId: 113, uidByte: "c4" },
		];
		for (const { kind, auctionId, uidByte } of cases) {
			const id = await bidProposal("executing", auctionId, uidByte);

			const { status } = await postNotify({ auctionId: auctionId.toString(), solutionId: 1, kind });
			expect(status).toBe(200);

			const updated = await store.get(app.ctx.db, id);
			expect(updated?.status, `${kind} must release the proposal back into competition`).toBe(
				"active",
			);
		}
	});

	// A driver-confirmed abandonment ("won but never settled", ADR-0003)
	// queues the 0.1 × c_l non-settlement debit; the pending charge lives in
	// the penalties queue, not in proposal state.
	it("abandoned submission queues a non-settlement penalty", async () => {
		const cases = [
			{ kind: "cancelled", auctionId: 114, uidByte: "c5" },
			{ kind: "expired", auctionId: 115, uidByte: "c6" },
			{ kind: "fail", auctionId: 116, uidByte: "c7" },
		];
		for (const { kind, auctionId, uidByte } of cases) {
			const id = await bidProposal("executing", auctionId, uidByte);

			await postNotify({ auctionId: auctionId.toString(), solutionId: 1, kind });

			const pending = await penaltiesFor(id);
			expect(pending, `${kind} must queue exactly one non-settlement penalty`).toHaveLength(1);
			expect(pending[0]?.subSolver.toLowerCase()).toBe(
				"0x0101010101010101010101010101010101010101",
			);
		}
	});

	// A duplicate abandonment finds the proposal already Active — the
	// stale-outcome guard drops it, so the sub-solver is not charged twice.
	it("duplicate abandonment does not queue a second penalty", async () => {
		const id = await bidProposal("executing", 117, "c8");

		const first = await postNotify({ auctionId: "117", solutionId: 1, kind: "fail" });
		expect(first.status).toBe(200);
		const second = await postNotify({ auctionId: "117", solutionId: 1, kind: "fail" });
		expect(second.status).toBe(200);

		expect(await penaltiesFor(id), "one lost settlement, one charge").toHaveLength(1);
	});

	// settlementStarted → success ends with the proposal Settled and the tx
	// hash readable on the owner's GET.
	it("success after settlementStarted settles with the tx hash on owner GET", async () => {
		const id = await bidProposal("active", 118, "c9", SIGNER_ACCOUNT.address);

		expect(
			(await postNotify({ auctionId: "118", solutionId: 1, kind: "settlementStarted" })).status,
		).toBe(200);
		const tx = `0x${"11".repeat(32)}` as Hex;
		expect(
			(await postNotify({ auctionId: "118", solutionId: 1, kind: "success", transaction: tx }))
				.status,
		).toBe(200);

		const sig = await readAuthHeader();
		const resp = await app.publicApp.request(`/proposal/${id}`, {
			headers: { "X-Signature": sig },
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.status).toBe("settled");
		expect(body.settlementTxHash).toBe(tx);
	});
});
