import type { Address, Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestContext } from "../../../test/setup.js";
import { createTestDb } from "../../../test/setup.js";
import type { Proposal } from "../../domain/proposal.js";
import * as store from "../storage.js";

let ctx: TestContext;

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
		buyAmount: 990_000n,
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
		nonce: 1n,
		signature: `0x${"ee".repeat(65)}` as Hex,
		status: "submitted",
		rejectionReason: null,
		gasUsed: null,
		trampoline: null,
		settlementTxHash: null,
		penaltyTxHash: null,
		pendingCancellation: false,
		...overrides,
	};
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

	it("transitions status with CAS", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal());
		const proposal = (await store.get(ctx.db, id))!;

		const result = await store.transition(ctx.db, proposal, "active");
		expect("auditEvent" in result).toBe(true);

		const updated = await store.get(ctx.db, id);
		expect(updated?.status).toBe("active");
	});

	it("stale transition fails", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal());
		const proposal = (await store.get(ctx.db, id))!;

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
		const p2 = (await store.get(ctx.db, id2))!;
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
		const p = (await store.get(ctx.db, id))!;
		await store.transition(ctx.db, p, "active");
		const active = (await store.get(ctx.db, id))!;

		const result = await store.applySettlementOutcome(ctx.db, active, { kind: "started" });
		expect("auditEvent" in result).toBe(true);

		const updated = await store.get(ctx.db, id);
		expect(updated?.status).toBe("executing");
	});

	it("sweeps dropped proposals", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal());
		const p = (await store.get(ctx.db, id))!;
		await store.transition(ctx.db, p, "rejected");

		// Sweep with 0 seconds — should catch everything
		const swept = await store.sweepDropped(ctx.db, 0);
		expect(swept).toBeGreaterThanOrEqual(1);

		const gone = await store.get(ctx.db, id);
		expect(gone).toBeNull();
	});

	it("records and retrieves solutions", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal());
		await store.recordSolution(ctx.db, 100, 1, id);

		const found = await store.solutionProposals(ctx.db, 100, [1]);
		expect(found).toHaveLength(1);
		expect(found[0]?.id).toBe(id);
	});

	it("defers cancellation of executing proposal", async () => {
		const sub = sampleProposal();
		const { id } = await store.insert(ctx.db, sub);
		const p = (await store.get(ctx.db, id))!;
		await store.transition(ctx.db, p, "active");
		const active = (await store.get(ctx.db, id))!;
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
		const p = (await store.get(ctx.db, id))!;
		await store.transition(ctx.db, p, "active");
		const active = (await store.get(ctx.db, id))!;
		await store.applySettlementOutcome(ctx.db, active, { kind: "started" });

		const r1 = await store.cancel(ctx.db, id, sub.subSolver);
		const r2 = await store.cancel(ctx.db, id, sub.subSolver);
		expect("deferred" in r1).toBe(true);
		expect("deferred" in r2).toBe(true);
	});

	it("abandoned with pendingCancellation transitions to cancelled", async () => {
		const sub = sampleProposal();
		const { id } = await store.insert(ctx.db, sub);
		const p = (await store.get(ctx.db, id))!;
		await store.transition(ctx.db, p, "active");
		const active = (await store.get(ctx.db, id))!;
		await store.applySettlementOutcome(ctx.db, active, { kind: "started" });

		// Set pending cancellation
		await store.cancel(ctx.db, id, sub.subSolver);

		const executing = (await store.get(ctx.db, id))!;
		const result = await store.applySettlementOutcome(ctx.db, executing, { kind: "abandoned" });
		expect("auditEvent" in result && result.insertedPenalty).toBe(true);

		const updated = await store.get(ctx.db, id);
		expect(updated?.status).toBe("cancelled");
		expect(updated?.pendingCancellation).toBe(false);
	});

	it("abandoned without pendingCancellation transitions to active", async () => {
		const sub = sampleProposal();
		const { id } = await store.insert(ctx.db, sub);
		const p = (await store.get(ctx.db, id))!;
		await store.transition(ctx.db, p, "active");
		const active = (await store.get(ctx.db, id))!;
		await store.applySettlementOutcome(ctx.db, active, { kind: "started" });

		const executing = (await store.get(ctx.db, id))!;
		const result = await store.applySettlementOutcome(ctx.db, executing, { kind: "abandoned" });
		expect("auditEvent" in result && result.insertedPenalty).toBe(true);

		const updated = await store.get(ctx.db, id);
		expect(updated?.status).toBe("active");
		expect(updated?.pendingCancellation).toBe(false);
	});

	it("succeeded clears pendingCancellation", async () => {
		const sub = sampleProposal();
		const { id } = await store.insert(ctx.db, sub);
		const p = (await store.get(ctx.db, id))!;
		await store.transition(ctx.db, p, "active");
		const active = (await store.get(ctx.db, id))!;
		await store.applySettlementOutcome(ctx.db, active, { kind: "started" });

		await store.cancel(ctx.db, id, sub.subSolver);

		const executing = (await store.get(ctx.db, id))!;
		await store.applySettlementOutcome(ctx.db, executing, {
			kind: "succeeded",
			txHash: "0xabc123" as Hex,
		});

		const updated = await store.get(ctx.db, id);
		expect(updated?.status).toBe("settled");
		expect(updated?.pendingCancellation).toBe(false);
	});
});
