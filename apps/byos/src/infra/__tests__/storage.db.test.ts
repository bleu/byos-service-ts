import type { Status } from "@byos/common";
import { sql } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestContext } from "../../../test/setup.js";
import { createTestDb } from "../../../test/setup.js";
import { solutions } from "../../db/schema.js";
import type { Proposal } from "../../domain/proposal.js";
import * as store from "../storage.js";

let ctx: TestContext;
let nonceCounter = 0n;

beforeAll(async () => {
	ctx = await createTestDb();
});

afterAll(async () => {
	await ctx.cleanup();
});

function sampleProposal(overrides?: Partial<Omit<Proposal, "id">>): Omit<Proposal, "id"> {
	return {
		subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address,
		orderUid: `0x${"ab".repeat(56)}`,
		orderUidHash: `0x${"cc".repeat(32)}` as Hex,
		sellAmount: 1_000_000n,
		minBuyAmount: 990_000n,
		quoteBuyAmount: 990_000n,
		sellToken: "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1" as Address,
		buyToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
		interactions: [
			{
				target: "0x0000000000000000000000000000000000000042" as Address,
				value: 0n,
				callData: "0xabcdef" as Hex,
			},
		],
		interactionsHash: `0x${"dd".repeat(32)}` as Hex,
		validUntil: 1_700_000_000n,
		nonce: nonceCounter++,
		signature: `0x${"ee".repeat(65)}` as Hex,
		status: "submitted",
		rejectionReason: null,
		gasUsed: null,
		trampoline: null,
		settlementTxHash: null,
		penaltyTxHash: null,
		pendingCancellation: false,
		supersededByProposalId: null,
		...overrides,
	};
}

async function getProposal(id: number): Promise<Proposal> {
	const proposal = await store.get(ctx.db, id);
	if (!proposal) throw new Error(`proposal ${id} missing`);
	return proposal;
}

describe("proposal store", () => {
	it("inserts and retrieves a proposal", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal());
		expect(id).toBeGreaterThan(0);

		const proposal = await store.get(ctx.db, id);
		expect(proposal).not.toBeNull();
		expect(proposal?.id).toBe(id);
		expect(proposal?.sellAmount).toBe(1_000_000n);
		expect(proposal?.status).toBe("submitted");
		expect(proposal?.interactions).toHaveLength(1);
	});

	it("returns null for non-existent id", async () => {
		const proposal = await store.get(ctx.db, 999999);
		expect(proposal).toBeNull();
	});

	// An id the column cannot hold names no row, so it is a miss rather than a
	// driver error the handler would surface as a 500.
	const unstorable = [1.5, 1e30, Number.MAX_SAFE_INTEGER + 2, Number.NaN, Number.POSITIVE_INFINITY];

	it.each(unstorable)("reads an unstorable id (%p) as a miss", async (id) => {
		await expect(store.get(ctx.db, id)).resolves.toBeNull();

		const owned = await store.getForOwner(ctx.db, id, sampleProposal().subSolver);
		expect("kind" in owned && owned.kind === "notFound").toBe(true);
	});

	it.each(unstorable)("cancelling an unstorable id (%p) is a miss", async (id) => {
		const result = await store.cancel(ctx.db, id, sampleProposal().subSolver);
		expect("kind" in result && result.kind === "notFound").toBe(true);
	});

	it("transitions status with CAS", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal());
		const proposal = await getProposal(id);

		const result = await store.transition(ctx.db, proposal, "active");
		expect("auditEvent" in result).toBe(true);

		const updated = await store.get(ctx.db, id);
		expect(updated?.status).toBe("active");
	});

	it("stale transition fails", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal());
		const proposal = await getProposal(id);

		// First transition succeeds
		await store.transition(ctx.db, proposal, "active");

		// Second transition with stale status fails
		const result = await store.transition(ctx.db, proposal, "rejected");
		expect("kind" in result && result.kind === "staleTransition").toBe(true);
	});

	it("resolves verdict to active", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal());
		const result = await store.resolveVerdict(ctx.db, id, {
			kind: "accept",
			simulation: {
				gasUsed: 150_000n,
				trampoline: "0x0000000000000000000000000000000000001234" as Address,
				sellToken: "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1" as Address,
				buyToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
			},
		});

		expect("status" in result).toBe(true);
		if ("status" in result) {
			expect(result.status).toBe("active");
			expect(result.auditEvent).not.toBeNull();
		}

		const updated = await store.get(ctx.db, id);
		expect(updated?.status).toBe("active");
		expect(updated?.gasUsed).toBe(150_000n);
	});

	it("resolves verdict to rejected", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal());
		const result = await store.resolveVerdict(ctx.db, id, {
			kind: "reject",
			reason: "InsufficientEscrow",
		});

		expect("status" in result).toBe(true);
		if ("status" in result) {
			expect(result.status).toBe("rejected");
		}
	});

	it("activating the newest proposal supersedes older live proposals for its sub-solver and order", async () => {
		const orderUid = `0x${"f1".repeat(56)}`;
		const { id: olderId } = await store.insert(ctx.db, sampleProposal({ orderUid }));
		await store.resolveVerdict(ctx.db, olderId, { kind: "accept", simulation: null });
		const { id: newerId } = await store.insert(ctx.db, sampleProposal({ orderUid }));

		const result = await store.resolveVerdict(ctx.db, newerId, {
			kind: "accept",
			simulation: null,
		});

		expect((await store.get(ctx.db, olderId))?.status).toBe("superseded");
		expect((await store.get(ctx.db, olderId))?.supersededByProposalId).toBe(newerId);
		expect((await store.get(ctx.db, newerId))?.status).toBe("active");
		if ("status" in result) {
			expect(result.supersessionAuditEvents).toHaveLength(1);
			expect(result.supersessionAuditEvents[0]?.kind).toMatchObject({
				type: "statusChanged",
				from: "active",
				to: "superseded",
			});
		}
	});

	it("serializes concurrent validators so an older proposal cannot reactivate", async () => {
		const orderUid = `0x${"f2".repeat(56)}`;
		const { id: olderId } = await store.insert(ctx.db, sampleProposal({ orderUid }));
		const { id: newerId } = await store.insert(ctx.db, sampleProposal({ orderUid }));

		await Promise.all([
			store.resolveVerdict(ctx.db, olderId, { kind: "accept", simulation: null }),
			store.resolveVerdict(ctx.db, newerId, { kind: "accept", simulation: null }),
		]);

		expect((await store.get(ctx.db, olderId))?.status).toBe("superseded");
		expect((await store.get(ctx.db, newerId))?.status).toBe("active");
	});

	it("never supersedes an executing proposal when a replacement activates", async () => {
		const orderUid = `0x${"f3".repeat(56)}`;
		const { id: executingId } = await store.insert(
			ctx.db,
			sampleProposal({ orderUid, status: "executing" }),
		);
		const { id: replacementId } = await store.insert(ctx.db, sampleProposal({ orderUid }));

		await store.resolveVerdict(ctx.db, replacementId, { kind: "accept", simulation: null });

		expect((await store.get(ctx.db, executingId))?.status).toBe("executing");
		expect((await store.get(ctx.db, replacementId))?.status).toBe("active");
	});

	it("accepts delayed terminal outcomes for superseded proposals", async () => {
		const { id: replacementId } = await store.insert(ctx.db, sampleProposal({ status: "active" }));
		const { id: abandonedId } = await store.insert(
			ctx.db,
			sampleProposal({ status: "superseded", supersededByProposalId: replacementId }),
		);
		const abandoned = await getProposal(abandonedId);
		await store.applySettlementOutcome(ctx.db, abandoned, { kind: "started" });
		const executing = await getProposal(abandonedId);
		await store.applySettlementOutcome(ctx.db, executing, { kind: "abandoned" });
		expect((await store.get(ctx.db, abandonedId))?.status).toBe("superseded");

		const { id: successId } = await store.insert(
			ctx.db,
			sampleProposal({ status: "superseded", supersededByProposalId: replacementId }),
		);
		const success = await getProposal(successId);
		await store.applySettlementOutcome(ctx.db, success, {
			kind: "succeeded",
			txHash: `0x${"11".repeat(32)}` as Hex,
		});
		expect((await store.get(ctx.db, successId))?.status).toBe("settled");

		const { id: revertId } = await store.insert(
			ctx.db,
			sampleProposal({ status: "superseded", supersededByProposalId: replacementId }),
		);
		const reverted = await getProposal(revertId);
		await store.applySettlementOutcome(ctx.db, reverted, {
			kind: "reverted",
			txHash: `0x${"12".repeat(32)}` as Hex,
		});
		expect((await store.get(ctx.db, revertId))?.status).toBe("settleFailed");
	});

	it("keeps superseded proposals out of solve reads and expires them", async () => {
		const orderUid = `0x${"f4".repeat(56)}`;
		const { id: supersededId } = await store.insert(
			ctx.db,
			sampleProposal({ orderUid, status: "superseded" }),
		);
		const { id: activeId } = await store.insert(
			ctx.db,
			sampleProposal({ orderUid, status: "active" }),
		);

		expect((await store.listByOrderUid(ctx.db, orderUid)).map((proposal) => proposal.id)).toEqual([
			activeId,
		]);
		const superseded = await getProposal(supersededId);
		await store.transition(ctx.db, superseded, "expired");
		expect((await store.get(ctx.db, supersededId))?.status).toBe("expired");
	});

	it("restores a timed-out superseded execution to superseded", async () => {
		const { id: replacementId } = await store.insert(ctx.db, sampleProposal({ status: "active" }));
		const { id } = await store.insert(
			ctx.db,
			sampleProposal({ status: "executing", supersededByProposalId: replacementId }),
		);
		await ctx.db.execute(
			sql`UPDATE proposals SET status_changed_at = now() - interval '61 seconds' WHERE id = ${id}`,
		);

		const events = await store.releaseStaleExecuting(ctx.db, 60);

		expect((await store.get(ctx.db, id))?.status).toBe("superseded");
		expect(events).toContainEqual(
			expect.objectContaining({
				kind: expect.objectContaining({ proposalId: id, to: "superseded" }),
			}),
		);
	});

	it("derives a fingerprint from all signed payload fields", async () => {
		const proposal = sampleProposal();
		const interaction = proposal.interactions[0];
		if (!interaction) throw new Error("sample proposal has no interaction");
		const differentRoute = {
			...proposal,
			interactions: [{ ...interaction, callData: "0xdeadbeef" as Hex }],
		};
		expect(store.signedProposalFingerprint(proposal)).not.toBe(
			store.signedProposalFingerprint(differentRoute),
		);
	});

	it("verdict on a terminal proposal is stale", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal({ status: "settled" }));

		const result = await store.resolveVerdict(ctx.db, id, { kind: "accept", simulation: null });

		expect("kind" in result && result.kind === "staleTransition").toBe(true);
		if ("kind" in result && result.kind === "staleTransition") {
			expect(result.actual).toBe("settled");
		}
		expect((await store.get(ctx.db, id))?.status).toBe("settled");
	});

	it("cancellation during validation wins over the verdict", async () => {
		const sub = sampleProposal();
		const { id } = await store.insert(ctx.db, sub);
		expect("auditEvent" in (await store.cancel(ctx.db, id, sub.subSolver))).toBe(true);

		// The verdict the validator was already computing when the cancel landed.
		const result = await store.resolveVerdict(ctx.db, id, { kind: "accept", simulation: null });

		// The variant matters, not just the failure: a plain "is it an error"
		// would also pass on a connection blip, which proves nothing about the
		// compare-and-swap.
		expect("kind" in result && result.kind === "staleTransition").toBe(true);
		if ("kind" in result && result.kind === "staleTransition") {
			expect(result.actual).toBe("cancelled");
		}
		expect((await store.get(ctx.db, id))?.status).toBe("cancelled");
	});

	it("cancels a submitted proposal", async () => {
		const sub = sampleProposal();
		const { id } = await store.insert(ctx.db, sub);

		const result = await store.cancel(ctx.db, id, sub.subSolver);
		expect("auditEvent" in result).toBe(true);

		const updated = await store.get(ctx.db, id);
		expect(updated?.status).toBe("cancelled");
	});

	it("cancel fails for wrong owner", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal());

		const result = await store.cancel(
			ctx.db,
			id,
			"0x0000000000000000000000000000000000000999" as Address,
		);
		expect("kind" in result && result.kind === "notOwner").toBe(true);
	});

	it("lists active proposals by order uid", async () => {
		const orderUid = `0x${"ff".repeat(56)}`;
		await store.insert(ctx.db, sampleProposal({ orderUid }));
		const { id: id2 } = await store.insert(ctx.db, sampleProposal({ orderUid }));

		// Make second one active
		const p2 = await getProposal(id2);
		await store.transition(ctx.db, p2, "active");

		const active = await store.listByOrderUid(ctx.db, orderUid);
		expect(active).toHaveLength(1);
		expect(active[0]?.status).toBe("active");
	});

	it("lists proposals by sub-solver", async () => {
		const subSolver = "0x1111111111111111111111111111111111111111" as Address;
		await store.insert(ctx.db, sampleProposal({ subSolver }));

		const list = await store.listBySubSolver(ctx.db, subSolver);
		expect(list.length).toBeGreaterThanOrEqual(1);
		expect(list.every((p) => p.subSolver.toLowerCase() === subSolver.toLowerCase())).toBe(true);
	});

	it("applies settlement outcome (started)", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal());
		const p = await getProposal(id);
		await store.transition(ctx.db, p, "active");
		const active = await getProposal(id);

		const result = await store.applySettlementOutcome(ctx.db, active, { kind: "started" });
		expect("auditEvent" in result).toBe(true);

		const updated = await store.get(ctx.db, id);
		expect(updated?.status).toBe("executing");
	});

	// The outcome is decided from the locked row, not the caller's copy. /notify
	// reads the proposal, then applies an outcome; in between, another
	// notification or the executing timeout can move the row.
	it("judges a settlement outcome against the committed status", async () => {
		const txHash = `0x${"33".repeat(32)}` as Hex;
		const { id } = await store.insert(ctx.db, sampleProposal({ status: "active" }));
		const stale = await getProposal(id);
		await store.transition(ctx.db, stale, "executing");

		// `stale` still reads "active"; the row is already "executing".
		const result = await store.applySettlementOutcome(ctx.db, stale, {
			kind: "reverted",
			txHash,
		});

		expect("auditEvent" in result).toBe(true);
		const updated = await store.get(ctx.db, id);
		expect(updated?.status).toBe("settleFailed");
		expect(updated?.settlementTxHash).toBe(txHash);
	});

	// Requiring "executing" here would forfeit the debit whenever
	// settlementStarted never landed — driver never sent it, its write failed,
	// or the two notifications arrived out of order.
	it("charges a revert that arrives without a preceding settlementStarted", async () => {
		const txHash = `0x${"44".repeat(32)}` as Hex;
		const { id } = await store.insert(ctx.db, sampleProposal({ status: "active" }));
		const proposal = await getProposal(id);

		const result = await store.applySettlementOutcome(ctx.db, proposal, {
			kind: "reverted",
			txHash,
		});

		expect("auditEvent" in result).toBe(true);
		const updated = await store.get(ctx.db, id);
		expect(updated?.status).toBe("settleFailed");
		// The penalty loop prices the debit off this tx.
		expect(updated?.settlementTxHash).toBe(txHash);
	});

	it("ignores an outcome illegal from the committed status", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal({ status: "cancelled" }));
		const proposal = await getProposal(id);

		const result = await store.applySettlementOutcome(ctx.db, proposal, { kind: "started" });

		// Not an error: the timeout backstop and re-simulation reconcile it.
		expect("auditEvent" in result && result.auditEvent).toBeNull();
		expect((await store.get(ctx.db, id))?.status).toBe("cancelled");
	});

	it("queues the non-settlement charge when an executing settlement is abandoned", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal({ status: "executing" }));
		const proposal = await getProposal(id);

		const result = await store.applySettlementOutcome(ctx.db, proposal, { kind: "abandoned" });

		expect("insertedPenalty" in result && result.insertedPenalty).toBe(true);
		// Back in the pool and still competing, with the charge queued separately.
		expect((await store.get(ctx.db, id))?.status).toBe("active");
		const queued = (await store.pendingPenalties(ctx.db)).filter((p) => p.proposalId === id);
		expect(queued).toHaveLength(1);
	});

	it("records and retrieves solutions", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal());
		await store.recordSolution(ctx.db, 100, 1, id, "0");

		const found = await store.solutionProposals(ctx.db, 100, [1]);
		expect(found).toHaveLength(1);
		expect(found[0]?.id).toBe(id);
	});

	it("defers cancellation of executing proposal", async () => {
		const sub = sampleProposal();
		const { id } = await store.insert(ctx.db, sub);
		const p = await getProposal(id);
		await store.transition(ctx.db, p, "active");
		const active = await getProposal(id);
		await store.applySettlementOutcome(ctx.db, active, { kind: "started" });

		const result = await store.cancel(ctx.db, id, sub.subSolver);
		expect("deferred" in result).toBe(true);

		const updated = await store.get(ctx.db, id);
		expect(updated?.status).toBe("executing");
		expect(updated?.pendingCancellation).toBe(true);
	});

	it("deferred cancel is idempotent", async () => {
		const sub = sampleProposal();
		const { id } = await store.insert(ctx.db, sub);
		const p = await getProposal(id);
		await store.transition(ctx.db, p, "active");
		const active = await getProposal(id);
		await store.applySettlementOutcome(ctx.db, active, { kind: "started" });

		const r1 = await store.cancel(ctx.db, id, sub.subSolver);
		const r2 = await store.cancel(ctx.db, id, sub.subSolver);
		expect("deferred" in r1).toBe(true);
		expect("deferred" in r2).toBe(true);
	});

	it("abandoned with pendingCancellation transitions to cancelled", async () => {
		const sub = sampleProposal();
		const { id } = await store.insert(ctx.db, sub);
		const p = await getProposal(id);
		await store.transition(ctx.db, p, "active");
		const active = await getProposal(id);
		await store.applySettlementOutcome(ctx.db, active, { kind: "started" });

		// Set pending cancellation
		await store.cancel(ctx.db, id, sub.subSolver);

		const executing = await getProposal(id);
		const result = await store.applySettlementOutcome(ctx.db, executing, { kind: "abandoned" });
		expect("auditEvent" in result && result.insertedPenalty).toBe(true);

		const updated = await store.get(ctx.db, id);
		expect(updated?.status).toBe("cancelled");
		expect(updated?.pendingCancellation).toBe(false);
	});

	it("abandoned without pendingCancellation transitions to active", async () => {
		const sub = sampleProposal();
		const { id } = await store.insert(ctx.db, sub);
		const p = await getProposal(id);
		await store.transition(ctx.db, p, "active");
		const active = await getProposal(id);
		await store.applySettlementOutcome(ctx.db, active, { kind: "started" });

		const executing = await getProposal(id);
		const result = await store.applySettlementOutcome(ctx.db, executing, { kind: "abandoned" });
		expect("auditEvent" in result && result.insertedPenalty).toBe(true);

		const updated = await store.get(ctx.db, id);
		expect(updated?.status).toBe("active");
		expect(updated?.pendingCancellation).toBe(false);
	});

	it("succeeded clears pendingCancellation", async () => {
		const sub = sampleProposal();
		const { id } = await store.insert(ctx.db, sub);
		const p = await getProposal(id);
		await store.transition(ctx.db, p, "active");
		const active = await getProposal(id);
		await store.applySettlementOutcome(ctx.db, active, { kind: "started" });

		await store.cancel(ctx.db, id, sub.subSolver);

		const executing = await getProposal(id);
		await store.applySettlementOutcome(ctx.db, executing, {
			kind: "succeeded",
			txHash: "0xabc123" as Hex,
		});

		const updated = await store.get(ctx.db, id);
		expect(updated?.status).toBe("settled");
		expect(updated?.pendingCancellation).toBe(false);
	});
});

// A sweep is table-wide, so these get a database each rather than sharing the
// one above — otherwise a row another test planted decides the counts.
describe("retention sweep", () => {
	const WINDOW_SECS = 3600;
	let sweep: TestContext;

	beforeEach(async () => {
		sweep = await createTestDb();
	});

	afterEach(async () => {
		await sweep.cleanup();
	});

	async function backdate(id: number, secs: number): Promise<void> {
		await sweep.db.execute(
			sql`UPDATE proposals SET status_changed_at = now() - make_interval(secs => ${secs}) WHERE id = ${id}`,
		);
	}

	const uid = (seed: number) => `0x${seed.toString(16).padStart(2, "0").repeat(56)}`;

	/** Insert a proposal already past the retention window. */
	async function insertAged(status: Status, seed: number): Promise<number> {
		const { id } = await store.insert(sweep.db, sampleProposal({ status, orderUid: uid(seed) }));
		await backdate(id, WINDOW_SECS * 2);
		return id;
	}

	// Every dropped-tier status, not just one: asserting only `rejected` means a
	// status quietly dropped from the sweep set leaves the table growing without
	// failing anything.
	it("deletes every dropped-tier status past the window", async () => {
		const dropped: Status[] = ["rejected", "simFailed", "expired", "cancelled"];
		const ids: Array<[Status, number]> = [];
		for (const [i, status] of dropped.entries()) {
			ids.push([status, await insertAged(status, i + 1)]);
		}

		expect(await store.sweepDropped(sweep.db, WINDOW_SECS)).toBe(4);

		for (const [status, id] of ids) {
			expect(await store.get(sweep.db, id), `a swept ${status} proposal reads as gone`).toBeNull();
		}
	});

	it("spares fresh dropped rows", async () => {
		const { id } = await store.insert(sweep.db, sampleProposal({ status: "rejected" }));

		expect(await store.sweepDropped(sweep.db, WINDOW_SECS)).toBe(0);
		expect(await store.get(sweep.db, id)).not.toBeNull();
	});

	// The money states are never swept, and neither are live or in-flight rows.
	it("never touches money states or live proposals", async () => {
		const spared: Status[] = [
			"settled",
			"settleFailed",
			"penalized",
			"executing",
			"active",
			"submitted",
		];
		const ids: Array<[Status, number]> = [];
		for (const [i, status] of spared.entries()) {
			ids.push([status, await insertAged(status, i + 1)]);
		}

		expect(await store.sweepDropped(sweep.db, WINDOW_SECS)).toBe(0);

		for (const [status, id] of ids) {
			expect(await store.get(sweep.db, id), `${status} must survive the sweep`).not.toBeNull();
		}
	});

	// A swept proposal takes its auction-participation rows with it; settled
	// proposals are never swept, so theirs survive.
	it("cascades solutions rows of dropped proposals only", async () => {
		const dropped = await insertAged("cancelled", 1);
		const settled = await insertAged("settled", 2);
		await store.recordSolution(sweep.db, 1, 1, dropped, "0");
		await store.recordSolution(sweep.db, 2, 1, settled, "0");

		expect(await store.sweepDropped(sweep.db, WINDOW_SECS)).toBe(1);

		const remaining = await sweep.db
			.select({ proposalId: solutions.proposalId })
			.from(solutions)
			.orderBy(solutions.proposalId);
		expect(remaining).toEqual([{ proposalId: settled }]);
	});
});
