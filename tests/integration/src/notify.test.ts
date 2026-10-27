import * as store from "@byos/byos/src/infra/storage.js";
import type { Address, Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createTestApp,
	readAuthHeader,
	SIGNER_ACCOUNT,
	seedProposal,
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

/** Seeds a proposal directly in the DB as "submitted" so /notify can look it up. */
async function seedActiveProposal(nonce: bigint): Promise<number> {
	return seedProposal(app.ctx.db, {
		orderUid: `0x${nonce.toString(16).padStart(4, "0").repeat(56).slice(0, 112)}`,
		status: "submitted",
	});
}

describe("/notify", () => {
	it("always returns 200 (fire-and-forget)", async () => {
		const { status } = await postNotify({
			auctionId: "999",
			solutionId: 999999,
			kind: "success",
			transaction: `0x${"aa".repeat(32)}`,
		});
		expect(status).toBe(200);
	});

	it("success notification transitions to settled", async () => {
		const id = await seedActiveProposal(300n);

		// In the new design, solutionId IS the proposalId.
		const txHash = `0x${"bb".repeat(32)}`;
		await postNotify({
			auctionId: "100",
			solutionId: id,
			kind: "success",
			transaction: txHash,
		});

		const updated = await store.get(app.ctx.db, id);
		expect(updated?.status).toBe("settled");
	});

	it("success notification cancels the sub-solver's other live proposals for the order", async () => {
		const orderUid = `0x${"f0".repeat(56)}`;
		const id = await seedProposal(app.ctx.db, {
			orderUid,
			status: "submitted",
			subSolver: SIGNER_ACCOUNT.address,
		});
		// Seed siblings with the same orderUid and subSolver — they should get cancelled.
		const siblingId = await seedProposal(app.ctx.db, {
			orderUid,
			status: "submitted",
			subSolver: SIGNER_ACCOUNT.address,
		});
		const anotherSiblingId = await seedProposal(app.ctx.db, {
			orderUid,
			status: "submitted",
			subSolver: SIGNER_ACCOUNT.address,
		});

		await postNotify({
			auctionId: "104",
			solutionId: id,
			kind: "success",
			transaction: `0x${"dd".repeat(32)}`,
		});

		expect((await store.get(app.ctx.db, id))?.status).toBe("settled");
		expect((await store.get(app.ctx.db, siblingId))?.status).toBe("cancelled");
		expect((await store.get(app.ctx.db, anotherSiblingId))?.status).toBe("cancelled");
		expect(
			app.auditEvents.filter(
				(event) =>
					event.kind.type === "statusChanged" &&
					(event.kind.proposalId === siblingId || event.kind.proposalId === anotherSiblingId) &&
					event.kind.to === "cancelled",
			),
		).toHaveLength(2);
	});

	it("revert notification transitions to settleFailed", async () => {
		const id = await seedActiveProposal(301n);

		const txHash = `0x${"cc".repeat(32)}`;
		await postNotify({
			auctionId: "101",
			solutionId: id,
			kind: "revert",
			transaction: txHash,
		});

		// settleFailed proposals are deleted from proposals table; check via log.
		const updated = await store.getIncludingLog(app.ctx.db, id);
		expect(updated?.status).toBe("settleFailed");
	});

	it("attributable non-outcome kind changes nothing, kept as audit evidence", async () => {
		const id = await seedActiveProposal(302n);

		const { status } = await postNotify({
			auctionId: "102",
			solutionId: id,
			kind: "emptySolution",
		});
		expect(status).toBe(200);

		// Pre-submission kinds carry no transition (ADR-0013)
		const updated = await store.get(app.ctx.db, id);
		expect(updated?.status).toBe("submitted");

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
		const proposal = await store.get(app.ctx.db, id);
		if (!proposal) throw new Error(`proposal ${id} missing`);
		await store.applySettlementOutcome(app.ctx.db, proposal, { kind: "started" });

		const { status } = await postNotify({
			auctionId: "103",
			solutionId: id,
			kind: "success",
			transaction: "0xzz",
		});
		expect(status).toBe(400);

		const updated = await store.get(app.ctx.db, id);
		// settlementStarted is a no-op in the new state machine; proposal stays submitted.
		expect(updated?.status).toBe("submitted");
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
	/** Seeds a "submitted" proposal in the DB (equivalent to a won /solve round). */
	async function bidProposal(
		_oldStatus: "active" | "executing",
		_auctionId: number,
		uidByte: string,
		subSolver?: Address,
	): Promise<number> {
		return seedProposal(app.ctx.db, {
			orderUid: `0x${uidByte.repeat(56)}`,
			status: "submitted",
			...(subSolver ? { subSolver } : {}),
		});
	}

	async function penaltiesFor(id: number) {
		return (await store.pendingPenalties(app.ctx.db)).filter((p) => p.proposalId === id);
	}

	it("settlementStarted is a no-op — proposal stays submitted", async () => {
		const id = await bidProposal("active", 110, "c1");

		const { status } = await postNotify({
			auctionId: "110",
			solutionId: id,
			kind: "settlementStarted",
		});
		expect(status).toBe(200);

		const updated = await store.get(app.ctx.db, id);
		expect(updated?.status).toBe("submitted");
	});

	// cancelled/expired/fail mean no tx landed — in the new state machine the
	// proposal transitions to "lost" (deleted from proposals, kept in proposals_log).
	it("abandoned submission marks the proposal lost", async () => {
		const cases = [
			{ kind: "cancelled", auctionId: 111, uidByte: "c2" },
			{ kind: "expired", auctionId: 112, uidByte: "c3" },
			{ kind: "fail", auctionId: 113, uidByte: "c4" },
		];
		for (const { kind, auctionId, uidByte } of cases) {
			const id = await bidProposal("executing", auctionId, uidByte);

			const { status } = await postNotify({
				auctionId: auctionId.toString(),
				solutionId: id,
				kind,
			});
			expect(status).toBe(200);

			// Proposal is deleted from proposals table and moved to proposals_log as "lost".
			const live = await store.get(app.ctx.db, id);
			expect(live, `${kind}: row must be removed from proposals`).toBeNull();
			const log = await store.getIncludingLog(app.ctx.db, id);
			expect(log?.status, `${kind} must mark the proposal lost`).toBe("lost");
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

			await postNotify({ auctionId: auctionId.toString(), solutionId: id, kind });

			const pending = await penaltiesFor(id);
			expect(pending, `${kind} must queue exactly one non-settlement penalty`).toHaveLength(1);
			expect(pending[0]?.subSolver.toLowerCase()).toBe(
				"0x0101010101010101010101010101010101010101",
			);
		}
	});

	// A duplicate abandonment finds the proposal already Lost — the
	// stale-outcome guard drops it, so the sub-solver is not charged twice.
	it("duplicate abandonment does not queue a second penalty", async () => {
		const id = await bidProposal("executing", 117, "c8");

		const first = await postNotify({ auctionId: "117", solutionId: id, kind: "fail" });
		expect(first.status).toBe(200);
		const second = await postNotify({ auctionId: "117", solutionId: id, kind: "fail" });
		expect(second.status).toBe(200);

		expect(await penaltiesFor(id), "one lost settlement, one charge").toHaveLength(1);
	});

	// settlementStarted → success ends with the proposal Settled and the tx
	// hash readable on the owner's GET.
	it("success after settlementStarted settles with the tx hash on owner GET", async () => {
		const id = await bidProposal("active", 118, "c9", SIGNER_ACCOUNT.address);

		expect(
			(await postNotify({ auctionId: "118", solutionId: id, kind: "settlementStarted" })).status,
		).toBe(200);
		const tx = `0x${"11".repeat(32)}` as Hex;
		expect(
			(await postNotify({ auctionId: "118", solutionId: id, kind: "success", transaction: tx }))
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
