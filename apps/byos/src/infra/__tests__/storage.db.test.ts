import { eq, sql } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestContext } from "../../../test/setup.js";
import { createTestDb } from "../../../test/setup.js";
import { proposalsLog } from "../../db/schema.js";
import type { Candidate } from "../candidate-store.js";
import * as store from "../storage.js";

let ctx: TestContext;

beforeAll(async () => {
	ctx = await createTestDb();
});

afterAll(async () => {
	await ctx.cleanup();
});

const SELL_TOKEN = "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1" as Address;
const BUY_TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address;
const TRAMPOLINE = "0x0000000000000000000000000000000000001234" as Address;
const SUB_SOLVER = "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address;

let idCounter = 1;
let nonceCounter = 0n;

function nextId() {
	return idCounter++;
}

const SOLUTION_PRICES: store.SolutionPrices = {
	sellTokenRefPrice: "1000000000000000000",
	surplusTokenRefPrice: "1000000000000000000",
	auctionGasPrice: "1000000000",
	clearingPrices: {
		[SELL_TOKEN]: "1000000000000000000",
		[BUY_TOKEN]: "1000000000000000000",
	},
};

function sampleCandidate(overrides?: Partial<Candidate>): Candidate {
	return {
		id: nextId(),
		subSolver: SUB_SOLVER,
		orderUid: `0x${"ab".repeat(56)}`,
		orderUidHash: `0x${"cc".repeat(32)}` as Hex,
		sellAmount: 1_000_000n,
		minBuyAmount: 990_000n,
		quoteBuyAmount: 990_000n,
		sellToken: SELL_TOKEN,
		buyToken: BUY_TOKEN,
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
		auctionId: 1,
		gasUsed: 150_000n,
		trampoline: TRAMPOLINE,
		simulationBuyAmount: null,
		sellTokenRefPrice: "1000000000000000000",
		createdAt: new Date(),
		...overrides,
	};
}

function sampleProposalInput(overrides?: Partial<store.ProposalInput>): store.ProposalInput {
	return {
		subSolver: SUB_SOLVER,
		orderUid: `0x${"ab".repeat(56)}`,
		orderUidHash: `0x${"cc".repeat(32)}` as Hex,
		sellAmount: 1_000_000n,
		minBuyAmount: 990_000n,
		quoteBuyAmount: 990_000n,
		sellToken: SELL_TOKEN,
		buyToken: BUY_TOKEN,
		interactions: [],
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
		sellTokenRefPrice: null,
		buyTokenRefPrice: null,
		surplusTokenRefPrice: null,
		auctionGasPrice: null,
		clearingPrices: null,
		simulationBuyAmount: null,
		auctionId: null,
		settlementPenaltyCap: null,
		...overrides,
	};
}

describe("insertAsSubmitted and get", () => {
	it("inserts a candidate as submitted and retrieves it", async () => {
		const candidate = sampleCandidate();
		await store.insertAsSubmitted(ctx.db, candidate, "1000000000000000000", SOLUTION_PRICES);

		const proposal = await store.get(ctx.db, candidate.id);
		expect(proposal).not.toBeNull();
		expect(proposal?.id).toBe(candidate.id);
		expect(proposal?.status).toBe("submitted");
		expect(proposal?.gasUsed).toBe(150_000n);
		expect(proposal?.trampoline?.toLowerCase()).toBe(TRAMPOLINE.toLowerCase());
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

		const owned = await store.getForOwner(ctx.db, id, SUB_SOLVER);
		expect("kind" in owned && owned.kind === "notFound").toBe(true);
	});
});

describe("writeToLog", () => {
	it("writes a rejected candidate directly to proposals_log", async () => {
		const id = nextId();
		const input = sampleProposalInput();

		await store.writeToLog(ctx.db, id, input, "rejected", "InsufficientEscrow", null);

		const [row] = await ctx.db
			.select()
			.from(proposalsLog)
			.where(eq(proposalsLog.id, id));
		expect(row).not.toBeUndefined();
		expect(row?.status).toBe("rejected");
		expect(row?.rejectionReason).toBe("InsufficientEscrow");
	});

	it("writes a cancelled candidate directly to proposals_log", async () => {
		const id = nextId();
		const input = sampleProposalInput();

		await store.writeToLog(ctx.db, id, input, "cancelled", null, null);

		const [row] = await ctx.db
			.select()
			.from(proposalsLog)
			.where(eq(proposalsLog.id, id));
		expect(row?.status).toBe("cancelled");
		expect(row?.rejectionReason).toBeNull();
	});

	it("writeToLog is idempotent (onConflictDoNothing)", async () => {
		const id = nextId();
		const input = sampleProposalInput();

		await store.writeToLog(ctx.db, id, input, "cancelled", null, null);
		// Second call must not throw
		await expect(
			store.writeToLog(ctx.db, id, input, "rejected", "InsufficientEscrow", null),
		).resolves.not.toThrow();

		// First write wins due to onConflictDoNothing
		const [row] = await ctx.db
			.select()
			.from(proposalsLog)
			.where(eq(proposalsLog.id, id));
		expect(row?.status).toBe("cancelled");
	});
});

describe("getIncludingLog", () => {
	it("finds a submitted proposal in the proposals table", async () => {
		const candidate = sampleCandidate();
		await store.insertAsSubmitted(ctx.db, candidate, "1000000000000000000", SOLUTION_PRICES);

		const proposal = await store.getIncludingLog(ctx.db, candidate.id);
		expect(proposal).not.toBeNull();
		expect(proposal?.id).toBe(candidate.id);
		expect(proposal?.status).toBe("submitted");
	});

	it("finds a log-only entry after settlement (deleted from proposals)", async () => {
		const candidate = sampleCandidate();
		await store.insertAsSubmitted(ctx.db, candidate, "1000000000000000000", SOLUTION_PRICES);

		// Simulate deletion (as happens on settled/lost outcome)
		await ctx.db.execute(sql`DELETE FROM proposals WHERE id = ${candidate.id}`);

		// The log still has it via trigger
		const proposal = await store.getIncludingLog(ctx.db, candidate.id);
		expect(proposal).not.toBeNull();
		expect(proposal?.id).toBe(candidate.id);
	});

	it("returns null for unknown id", async () => {
		const result = await store.getIncludingLog(ctx.db, 9_999_999);
		expect(result).toBeNull();
	});
});

describe("applySettlementOutcome (submitted proposals)", () => {
	it("transitions submitted → settled and deletes the row", async () => {
		const txHash = `0x${"55".repeat(32)}` as Hex;
		const candidate = sampleCandidate();
		await store.insertAsSubmitted(ctx.db, candidate, "1000000000000000000", SOLUTION_PRICES);
		const proposal = (await store.get(ctx.db, candidate.id))!;

		const result = await store.applySettlementOutcome(ctx.db, proposal, {
			kind: "succeeded",
			txHash,
		});

		expect("auditEvent" in result).toBe(true);
		if ("auditEvent" in result) {
			expect(result.auditEvent?.kind).toMatchObject({
				type: "statusChanged",
				from: "submitted",
				to: "settled",
				settlementTxHash: txHash,
			});
		}
		// Settled rows remain in the proposals table for buffer accounting.
		const settled = await store.get(ctx.db, candidate.id);
		expect(settled?.status).toBe("settled");
		// The log also retains it (via trigger)
		const logEntry = await store.getIncludingLog(ctx.db, candidate.id);
		expect(logEntry).not.toBeNull();
	});

	it("transitions submitted → settleFailed on revert", async () => {
		const txHash = `0x${"44".repeat(32)}` as Hex;
		const candidate = sampleCandidate();
		await store.insertAsSubmitted(ctx.db, candidate, "1000000000000000000", SOLUTION_PRICES);
		const proposal = (await store.get(ctx.db, candidate.id))!;

		const result = await store.applySettlementOutcome(ctx.db, proposal, {
			kind: "reverted",
			txHash,
		});

		expect("auditEvent" in result).toBe(true);
		const updated = await store.get(ctx.db, candidate.id);
		expect(updated?.status).toBe("settleFailed");
		expect(updated?.settlementTxHash).toBe(txHash);
	});

	it("transitions submitted → lost on abandoned, queues penalty, deletes the row", async () => {
		const candidate = sampleCandidate();
		await store.insertAsSubmitted(ctx.db, candidate, "1000000000000000000", SOLUTION_PRICES);
		const proposal = (await store.get(ctx.db, candidate.id))!;

		const result = await store.applySettlementOutcome(ctx.db, proposal, { kind: "abandoned" });

		expect("insertedPenalty" in result && result.insertedPenalty).toBe(true);
		// Lost rows are deleted immediately
		expect(await store.get(ctx.db, candidate.id)).toBeNull();
		const queued = (await store.pendingPenalties(ctx.db)).filter(
			(p) => p.proposalId === candidate.id,
		);
		expect(queued).toHaveLength(1);
	});

	it("started is a no-op for submitted proposals", async () => {
		const candidate = sampleCandidate();
		await store.insertAsSubmitted(ctx.db, candidate, "1000000000000000000", SOLUTION_PRICES);
		const proposal = (await store.get(ctx.db, candidate.id))!;

		const result = await store.applySettlementOutcome(ctx.db, proposal, { kind: "started" });

		// No state change: started is a no-op in the new design
		expect("auditEvent" in result && result.auditEvent).toBeNull();
		const updated = await store.get(ctx.db, candidate.id);
		expect(updated?.status).toBe("submitted");
	});

	it("ignores an outcome illegal from the committed status", async () => {
		const id = nextId();
		const input = sampleProposalInput();
		await store.writeToLog(ctx.db, id, input, "cancelled", null, null);

		// No live row — getIncludingLog reads from log, applySettlementOutcome finds notFound
		const logProposal = await store.getIncludingLog(ctx.db, id);
		expect(logProposal).not.toBeNull();
		const result = await store.applySettlementOutcome(ctx.db, logProposal!, { kind: "started" });
		// notFound is returned when no live row exists
		expect("kind" in result && result.kind === "notFound").toBe(true);
	});
});

describe("transition", () => {
	it("transitions status with CAS", async () => {
		const candidate = sampleCandidate();
		await store.insertAsSubmitted(ctx.db, candidate, "1000000000000000000", SOLUTION_PRICES);
		const proposal = (await store.get(ctx.db, candidate.id))!;

		const result = await store.transition(ctx.db, proposal, "settleFailed");
		expect("auditEvent" in result).toBe(true);

		const updated = await store.get(ctx.db, candidate.id);
		expect(updated?.status).toBe("settleFailed");
	});

	it("stale transition fails", async () => {
		const candidate = sampleCandidate();
		await store.insertAsSubmitted(ctx.db, candidate, "1000000000000000000", SOLUTION_PRICES);
		const proposal = (await store.get(ctx.db, candidate.id))!;

		// First transition succeeds
		await store.transition(ctx.db, proposal, "settleFailed");

		// Second transition with stale status fails
		const result = await store.transition(ctx.db, proposal, "penalized");
		expect("kind" in result && result.kind === "staleTransition").toBe(true);
	});
});

describe("getForOwner", () => {
	it("returns the proposal when owner matches", async () => {
		const candidate = sampleCandidate();
		await store.insertAsSubmitted(ctx.db, candidate, "1000000000000000000", SOLUTION_PRICES);

		const result = await store.getForOwner(ctx.db, candidate.id, candidate.subSolver);
		expect("kind" in result).toBe(false);
		if (!("kind" in result)) {
			expect(result.id).toBe(candidate.id);
		}
	});

	it("returns notFound when owner does not match", async () => {
		const candidate = sampleCandidate();
		await store.insertAsSubmitted(ctx.db, candidate, "1000000000000000000", SOLUTION_PRICES);

		const result = await store.getForOwner(
			ctx.db,
			candidate.id,
			"0x0000000000000000000000000000000000000999" as Address,
		);
		expect("kind" in result && result.kind === "notFound").toBe(true);
	});

	it("falls back to proposals_log for swept proposals", async () => {
		const id = nextId();
		const input = sampleProposalInput();
		await store.writeToLog(ctx.db, id, input, "cancelled", null, null);

		const result = await store.getForOwner(ctx.db, id, input.subSolver);
		expect("kind" in result).toBe(false);
		if (!("kind" in result)) {
			expect(result.id).toBe(id);
			expect(result.status).toBe("cancelled");
		}
	});
});

describe("signedProposalFingerprint", () => {
	it("derives a fingerprint from all signed payload fields", () => {
		const proposal = sampleProposalInput();
		const differentRoute = {
			...proposal,
			interactions: [{ ...proposal.interactions[0]!, callData: "0xdeadbeef" as Hex }],
		};
		expect(store.signedProposalFingerprint(proposal)).not.toBe(
			store.signedProposalFingerprint(differentRoute),
		);
	});

	it("canonicalizes calldata casing in the signed payload fingerprint", () => {
		const proposal = sampleProposalInput({
			interactions: [
				{
					target: "0x00000000000000000000000000000000000000cc" as Address,
					value: 0n,
					callData: "0xdeadbeef" as Hex,
				},
			],
		});
		const sameBytesDifferentCasing = {
			...proposal,
			interactions: [{ ...proposal.interactions[0]!, callData: "0xDEADBEEF" as Hex }],
		};

		expect(store.signedProposalFingerprint(proposal)).toBe(
			store.signedProposalFingerprint(sameBytesDifferentCasing),
		);
	});
});

describe("listBySubSolver", () => {
	it("lists submitted proposals by sub-solver", async () => {
		const subSolver = "0x1111111111111111111111111111111111111111" as Address;
		const candidate = sampleCandidate({ subSolver });
		await store.insertAsSubmitted(ctx.db, candidate, "1000000000000000000", SOLUTION_PRICES);

		const list = await store.listBySubSolver(ctx.db, subSolver);
		expect(list.length).toBeGreaterThanOrEqual(1);
		expect(list.every((p) => p.subSolver.toLowerCase() === subSolver.toLowerCase())).toBe(true);
	});
});

describe("fetchInflightDataBySubSolver", () => {
	it("returns submitted proposals for the sub-solver", async () => {
		const isolated = await createTestDb();
		try {
			const subSolver = "0x2222222222222222222222222222222222222222" as Address;
			const c1 = sampleCandidate({ subSolver });
			const c2 = sampleCandidate({ subSolver });
			await store.insertAsSubmitted(isolated.db, c1, "1000000000000000000", SOLUTION_PRICES);
			await store.insertAsSubmitted(isolated.db, c2, "1000000000000000000", SOLUTION_PRICES);

			const snapshot = await store.fetchInflightDataBySubSolver(isolated.db, subSolver);
			expect(snapshot.proposals.map((p) => p.id).sort()).toEqual([c1.id, c2.id].sort());
		} finally {
			await isolated.cleanup();
		}
	});

	it("excludes proposals from other sub-solvers", async () => {
		const isolated = await createTestDb();
		try {
			const subSolverA = "0x3333333333333333333333333333333333333333" as Address;
			const subSolverB = "0x4444444444444444444444444444444444444444" as Address;
			const ca = sampleCandidate({ subSolver: subSolverA });
			const cb = sampleCandidate({ subSolver: subSolverB });
			await store.insertAsSubmitted(isolated.db, ca, "1000000000000000000", SOLUTION_PRICES);
			await store.insertAsSubmitted(isolated.db, cb, "1000000000000000000", SOLUTION_PRICES);

			const snapshot = await store.fetchInflightDataBySubSolver(isolated.db, subSolverA);
			expect(snapshot.proposals.map((p) => p.id)).toEqual([ca.id]);
		} finally {
			await isolated.cleanup();
		}
	});
});

describe("log redaction", () => {
	const WINDOW_SECS = 3600;
	let redactCtx: TestContext;

	beforeEach(async () => {
		redactCtx = await createTestDb();
	});

	afterEach(async () => {
		await redactCtx.cleanup();
	});

	const uid = (seed: number) => `0x${seed.toString(16).padStart(2, "0").repeat(56)}`;

	/** Insert a candidate and backdate its created_at in proposals_log. */
	async function insertAgedLog(seed: number): Promise<number> {
		const id = nextId();
		const input = sampleProposalInput({ orderUid: uid(seed) });
		await store.writeToLog(redactCtx.db, id, input, "cancelled", null, null);
		await redactCtx.db.execute(
			sql`UPDATE proposals_log SET created_at = now() - make_interval(secs => ${WINDOW_SECS * 2}) WHERE id = ${id}`,
		);
		return id;
	}

	async function logRow(id: number) {
		const [row] = await redactCtx.db
			.select({
				interactions: proposalsLog.interactions,
				simulationFailureParams: proposalsLog.simulationFailureParams,
			})
			.from(proposalsLog)
			.where(eq(proposalsLog.id, id));
		return row;
	}

	it("clears interactions and simulationFailureParams on aged rows", async () => {
		const id = await insertAgedLog(1);
		await redactCtx.db.execute(
			sql`UPDATE proposals_log SET simulation_failure_params = '{"chainId":1,"calldata":"0xdeadbeef"}'::jsonb WHERE id = ${id}`,
		);

		expect(await store.redactOldLogEntries(redactCtx.db, WINDOW_SECS)).toBe(1);

		const row = await logRow(id);
		expect(row?.interactions).toEqual([]);
		expect(row?.simulationFailureParams).toBeNull();
	});

	it("skips rows younger than the window", async () => {
		const id = nextId();
		const input = sampleProposalInput({ orderUid: uid(2) });
		await store.writeToLog(redactCtx.db, id, input, "cancelled", null, null);

		expect(await store.redactOldLogEntries(redactCtx.db, WINDOW_SECS)).toBe(0);

		const row = await logRow(id);
		expect(row?.interactions).toBeDefined();
	});

	it("is idempotent — already-redacted rows are not counted twice", async () => {
		const id = await insertAgedLog(3);
		await store.redactOldLogEntries(redactCtx.db, WINDOW_SECS);

		expect(await store.redactOldLogEntries(redactCtx.db, WINDOW_SECS)).toBe(0);

		const row = await logRow(id);
		expect(row?.interactions).toEqual([]);
		expect(row?.simulationFailureParams).toBeNull();
	});
});
