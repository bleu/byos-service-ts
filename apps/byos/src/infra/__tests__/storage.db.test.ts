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

	it("records and retrieves solutions", async () => {
		const { id } = await store.insert(ctx.db, sampleProposal());
		await store.recordSolution(ctx.db, 100, 1, id);

		const found = await store.solutionProposals(ctx.db, 100, [1]);
		expect(found).toHaveLength(1);
		expect(found[0]?.id).toBe(id);
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
		await store.recordSolution(sweep.db, 1, 1, dropped);
		await store.recordSolution(sweep.db, 2, 1, settled);

		expect(await store.sweepDropped(sweep.db, WINDOW_SECS)).toBe(1);

		const remaining = await sweep.db
			.select({ proposalId: solutions.proposalId })
			.from(solutions)
			.orderBy(solutions.proposalId);
		expect(remaining).toEqual([{ proposalId: settled }]);
	});
});
