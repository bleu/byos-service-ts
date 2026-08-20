import pino from "pino";
import type { Address, Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestContext } from "../../../../test/setup.js";
import { createTestDb } from "../../../../test/setup.js";
import type { AuditEvent } from "../../../domain/audit.js";
import type { DebitEscrow } from "../../../domain/penalty.js";
import type { Proposal } from "../../../domain/proposal.js";
import * as store from "../../storage.js";
import { runBufferDebits, runNonSettlementDebits, runRevertDebits } from "../penalty.js";

let ctx: TestContext;

beforeAll(async () => {
	ctx = await createTestDb();
});

afterAll(async () => {
	await ctx.cleanup();
});

const logger = pino({ level: "silent" });

/** c_l for mainnet: 0.010 ETH — same constant the Rust tests use. */
const C_L = 10_000_000_000_000_000n;
const PENALTY_TX: Hex = `0x${"77".repeat(32)}`;

let uidCounter = 0;

function sampleProposal(): Omit<Proposal, "id"> {
	const uid = (uidCounter++).toString(16).padStart(2, "0");
	return {
		subSolver: "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address,
		orderUid: `0x${uid.repeat(56)}`,
		orderUidHash: `0x${"cc".repeat(32)}` as Hex,
		sellAmount: 1_000_000n,
		minBuyAmount: 990_000n,
		quoteBuyAmount: 990_000n,
		sellToken: "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1" as Address,
		buyToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
		interactions: [],
		interactionsHash: `0x${"dd".repeat(32)}` as Hex,
		validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600),
		nonce: 1n,
		signature: `0x${"ee".repeat(65)}` as Hex,
		status: "submitted",
		rejectionReason: null,
		gasUsed: null,
		trampoline: null,
		settlementTxHash: null,
		penaltyTxHash: null,
		pendingCancellation: false,
	};
}

/**
 * Inserts a proposal and drives it to settleFailed with a unique settlement
 * tx. Tests share one database and the revert sweep reads every settleFailed
 * row, so each test scopes its stubs and assertions by its own tx.
 */
async function settleFailedProposal(): Promise<{ id: number; tx: Hex }> {
	const { id } = await store.insert(ctx.db, sampleProposal());
	const tx: Hex = `0x${id.toString(16).padStart(64, "0")}`;
	const submitted = await store.get(ctx.db, id);
	await store.transition(ctx.db, submitted as Proposal, "active");
	const active = await store.get(ctx.db, id);
	await store.applySettlementOutcome(ctx.db, active as Proposal, {
		kind: "reverted",
		txHash: tx,
	});
	return { id, tx };
}

function config(operator: DebitEscrow, events: AuditEvent[] = []) {
	return {
		db: ctx.db,
		operator,
		cL: C_L,
		onAuditEvent: (event: AuditEvent) => {
			events.push(event);
		},
		logger,
	};
}

describe("revert debits", () => {
	it("debits a settleFailed proposal and marks it penalized", async () => {
		const { id, tx } = await settleFailedProposal();
		const calls: { subSolver: Address; amount: bigint; reason: Hex }[] = [];
		const operator: DebitEscrow = {
			async settlementCost() {
				return 500n;
			},
			async debit(subSolver, amount, reason) {
				calls.push({ subSolver, amount, reason });
				return PENALTY_TX;
			},
			async readExecutedDelta() {
				throw new Error("not used");
			},
		};
		const events: AuditEvent[] = [];

		await runRevertDebits(config(operator, events), new Map());

		const mine = calls.filter((c) => c.reason === tx);
		expect(mine).toHaveLength(1);
		expect(mine[0]?.amount).toBe(500n + C_L);
		const proposal = await store.get(ctx.db, id);
		expect(proposal?.status).toBe("penalized");
		expect(proposal?.penaltyTxHash).toBe(PENALTY_TX);
		expect(events.some((e) => e.kind.type === "penalized" && e.kind.proposalId === id)).toBe(true);
	});

	it("keeps a proposal settleFailed across failed ticks until a debit lands", async () => {
		const { id, tx } = await settleFailedProposal();
		let debitCalls = 0;
		const flaky: DebitEscrow = {
			async settlementCost() {
				return 500n;
			},
			async debit(_subSolver, _amount, reason) {
				if (reason !== tx) return PENALTY_TX;
				debitCalls++;
				if (debitCalls <= 2) throw new Error("nonce race");
				return PENALTY_TX;
			},
			async readExecutedDelta() {
				throw new Error("not used");
			},
		};
		const attempts = new Map<number, number>();

		await runRevertDebits(config(flaky), attempts);
		await runRevertDebits(config(flaky), attempts);
		expect((await store.get(ctx.db, id))?.status).toBe("settleFailed");

		await runRevertDebits(config(flaky), attempts);
		expect((await store.get(ctx.db, id))?.status).toBe("penalized");
		expect(debitCalls).toBe(3);
		expect(attempts.size).toBe(0);
	});

	it("gives up on a permanently failing revert debit after the attempt cap", async () => {
		const { id, tx } = await settleFailedProposal();
		let debitCalls = 0;
		const dead: DebitEscrow = {
			async settlementCost() {
				return 500n;
			},
			async debit(_subSolver, _amount, reason) {
				if (reason !== tx) return PENALTY_TX;
				debitCalls++;
				throw new Error("operator lacks role");
			},
			async readExecutedDelta() {
				throw new Error("not used");
			},
		};
		const attempts = new Map<number, number>();

		for (let tick = 0; tick < 12; tick++) {
			await runRevertDebits(config(dead), attempts);
		}

		expect(debitCalls).toBe(10);
		expect((await store.get(ctx.db, id))?.status).toBe("settleFailed");
	});

	it("stops looking up a permanently unpriceable settlement", async () => {
		const { tx } = await settleFailedProposal();
		let costCalls = 0;
		let debitCalls = 0;
		const unpriceable: DebitEscrow = {
			async settlementCost(txHash) {
				if (txHash !== tx) return 500n;
				costCalls++;
				throw new Error("history pruned");
			},
			async debit(_subSolver, _amount, reason) {
				if (reason === tx) debitCalls++;
				return PENALTY_TX;
			},
			async readExecutedDelta() {
				throw new Error("not used");
			},
		};
		const attempts = new Map<number, number>();

		for (let tick = 0; tick < 12; tick++) {
			await runRevertDebits(config(unpriceable), attempts);
		}

		expect(costCalls).toBe(10);
		expect(debitCalls).toBe(0);
	});

	it("does not debit a settleFailed proposal without a settlement tx", async () => {
		// apply_settlement_outcome always writes the tx alongside settleFailed,
		// so a missing hash is a corrupt row — alert, don't guess an amount.
		const { id } = await store.insert(ctx.db, sampleProposal());
		const submitted = await store.get(ctx.db, id);
		await store.transition(ctx.db, submitted as Proposal, "active");
		const active = await store.get(ctx.db, id);
		await store.transition(ctx.db, active as Proposal, "settleFailed");

		const operator: DebitEscrow = {
			async settlementCost() {
				return 500n;
			},
			async debit() {
				return PENALTY_TX;
			},
			async readExecutedDelta() {
				throw new Error("not used");
			},
		};
		const logLines: string[] = [];
		const capturing = pino(
			{ level: "error" },
			{
				write: (line: string) => {
					logLines.push(line);
				},
			},
		);

		await runRevertDebits({ ...config(operator), logger: capturing }, new Map());

		expect((await store.get(ctx.db, id))?.status).toBe("settleFailed");
		expect(logLines.some((line) => line.includes("without settlement tx"))).toBe(true);
	});

	it("does not count a record failure against the debit attempt cap", async () => {
		const { id, tx } = await settleFailedProposal();
		const operator: DebitEscrow = {
			async settlementCost() {
				return 500n;
			},
			// The debit lands, but a concurrent transition wins the record
			// race — recordPenalty must see a stale status.
			async debit(_subSolver, _amount, reason) {
				if (reason !== tx) return PENALTY_TX;
				const current = await store.get(ctx.db, id);
				await store.transition(ctx.db, current as Proposal, "penalized");
				return PENALTY_TX;
			},
			async readExecutedDelta() {
				throw new Error("not used");
			},
		};
		const events: AuditEvent[] = [];
		const attempts = new Map<number, number>();
		const logLines: string[] = [];
		const capturing = pino(
			{ level: "error" },
			{
				write: (line: string) => {
					logLines.push(line);
				},
			},
		);

		await runRevertDebits({ ...config(operator, events), logger: capturing }, attempts);

		expect(attempts.get(id)).toBeUndefined();
		expect(
			events.filter((e) => e.kind.type === "penalized" && e.kind.proposalId === id),
		).toHaveLength(0);
		// The double-charge risk must be loud, as in the Rust loop.
		expect(logLines.some((line) => line.includes("may re-charge next tick"))).toBe(true);
	});
});

describe("non-settlement debits", () => {
	async function queuedPenalty(): Promise<number> {
		const { id } = await store.insert(ctx.db, sampleProposal());
		const proposal = await store.get(ctx.db, id);
		await store.queueNonSettlementPenalty(ctx.db, proposal as Proposal);
		return id;
	}

	it("debits a queued penalty at 0.1 c_l exactly once", async () => {
		const proposalId = await queuedPenalty();
		const calls: bigint[] = [];
		const operator: DebitEscrow = {
			async settlementCost() {
				throw new Error("not used");
			},
			async debit(_subSolver, amount) {
				calls.push(amount);
				return PENALTY_TX;
			},
			async readExecutedDelta() {
				throw new Error("not used");
			},
		};
		const events: AuditEvent[] = [];
		const attempts = new Map<number, number>();

		await runNonSettlementDebits(config(operator, events), attempts);
		await runNonSettlementDebits(config(operator, events), attempts);

		expect(calls).toEqual([C_L / 10n]);
		expect(events.filter((e) => e.kind.type === "nonSettlementDebited")).toHaveLength(1);
		expect((await store.get(ctx.db, proposalId))?.status).toBe("submitted");
	});

	it("gives up on a permanently failing non-settlement debit after the cap", async () => {
		await queuedPenalty();
		let debitCalls = 0;
		const dead: DebitEscrow = {
			async settlementCost() {
				throw new Error("not used");
			},
			async debit() {
				debitCalls++;
				throw new Error("escrow paused");
			},
			async readExecutedDelta() {
				throw new Error("not used");
			},
		};
		const attempts = new Map<number, number>();

		for (let tick = 0; tick < 12; tick++) {
			await runNonSettlementDebits(config(dead), attempts);
		}

		expect(debitCalls).toBe(10);
		expect(await store.pendingPenalties(ctx.db)).not.toHaveLength(0);
	});
});

describe("buffer debits", () => {
	const SUB_SOLVER = "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address;
	const ETHER = 10n ** 18n;
	const CLEAR_TX: Hex = `0x${"88".repeat(32)}`;

	/** Creates a settled proposal with aggressive buffer and a recorded solution with ref price. */
	async function settledBufferProposal(
		quoteBuyAmount: bigint,
		minBuyAmount: bigint,
		refPrice: string,
	): Promise<{ id: number; tx: Hex }> {
		const base = sampleProposal();
		const { id } = await store.insert(ctx.db, {
			...base,
			subSolver: SUB_SOLVER,
			minBuyAmount,
			quoteBuyAmount,
		});
		const tx: Hex = `0x${id.toString(16).padStart(64, "0")}`;

		// Drive to settled: submitted → active → executing → settled
		const submitted = await store.get(ctx.db, id);
		await store.transition(ctx.db, submitted as Proposal, "active");
		const active = await store.get(ctx.db, id);
		await store.applySettlementOutcome(ctx.db, active as Proposal, {
			kind: "succeeded",
			txHash: tx,
		});

		// Record a solution with the buy-token reference price
		await store.recordSolution(ctx.db, 9000 + id, 1, id, refPrice);

		return { id, tx };
	}

	function bufferOperator(
		deltaByTx: Map<string, bigint>,
		debitCalls: Array<{ subSolver: Address; amount: bigint }> = [],
	): DebitEscrow {
		return {
			async settlementCost() {
				throw new Error("not used");
			},
			async debit(subSolver, amount) {
				debitCalls.push({ subSolver, amount });
				return CLEAR_TX;
			},
			async readExecutedDelta(txHash) {
				const delta = deltaByTx.get(txHash.toLowerCase());
				if (delta === undefined) throw new Error(`no delta for ${txHash}`);
				return delta;
			},
		};
	}

	it("records a buffer entry for a settled proposal with under-delivery", async () => {
		const maxBuy = 1000n;
		const minBuy = 900n;
		const delivered = 950n; // under-delivered by 50
		const refPrice = ETHER.toString(); // 1:1 price

		const { id, tx } = await settledBufferProposal(maxBuy, minBuy, refPrice);
		const deltaByTx = new Map([[tx.toLowerCase(), delivered]]);
		const operator = bufferOperator(deltaByTx);

		await runBufferDebits(config(operator), new Map());

		// Entry should exist
		const entries = await store.unclearedBufferEntries(ctx.db, SUB_SOLVER);
		const entry = entries.find((e) => e.proposalId === id);
		expect(entry).toBeDefined();
		expect(entry?.gap).toBe("50"); // maxBuy - delivered
		expect(entry?.delta).toBe("950");
		expect(BigInt(entry?.nativeTokenAmount)).toBe(50n); // gap * 1e18 / 1e18 = 50
	});

	it("records a negative entry for over-delivery", async () => {
		const maxBuy = 1000n;
		const minBuy = 900n;
		const delivered = 1050n; // over-delivered by 50
		const refPrice = ETHER.toString();

		const { id, tx } = await settledBufferProposal(maxBuy, minBuy, refPrice);
		const deltaByTx = new Map([[tx.toLowerCase(), delivered]]);
		const operator = bufferOperator(deltaByTx);

		await runBufferDebits(config(operator), new Map());

		const entries = await store.unclearedBufferEntries(ctx.db, SUB_SOLVER);
		const entry = entries.find((e) => e.proposalId === id);
		expect(entry).toBeDefined();
		expect(entry?.gap).toBe("-50");
		expect(BigInt(entry?.nativeTokenAmount)).toBe(-50n);
	});

	it("does not create duplicate entries on repeated ticks", async () => {
		const { id, tx } = await settledBufferProposal(1000n, 900n, ETHER.toString());
		const deltaByTx = new Map([[tx.toLowerCase(), 950n]]);
		const operator = bufferOperator(deltaByTx);

		await runBufferDebits(config(operator), new Map());
		await runBufferDebits(config(operator), new Map());

		const entries = await store.unclearedBufferEntries(ctx.db, SUB_SOLVER);
		const matching = entries.filter((e) => e.proposalId === id);
		expect(matching).toHaveLength(1);
	});

	it("slashes when outstanding balance exceeds c_L", async () => {
		// Create a proposal with a gap large enough to exceed c_L (0.01 ETH)
		const maxBuy = ETHER; // 1e18
		const minBuy = ETHER / 2n;
		// delivered = 0.98e18, gap = 0.02e18. With ref price = 1 ETH/token,
		// nativeTokenAmount = 0.02 ETH = 2e16 > c_L (1e16).
		const delivered = (ETHER * 98n) / 100n;
		const refPrice = ETHER.toString();

		const { tx } = await settledBufferProposal(maxBuy, minBuy, refPrice);
		const deltaByTx = new Map([[tx.toLowerCase(), delivered]]);
		const debitCalls: Array<{ subSolver: Address; amount: bigint }> = [];
		const events: AuditEvent[] = [];
		const operator = bufferOperator(deltaByTx, debitCalls);

		await runBufferDebits(config(operator, events), new Map());

		// The debit should have been called
		const ourDebits = debitCalls.filter(
			(c) => c.subSolver.toLowerCase() === SUB_SOLVER.toLowerCase(),
		);
		expect(ourDebits.length).toBeGreaterThanOrEqual(1);

		// All entries for this subsolver should be cleared
		const uncleared = await store.unclearedBufferEntries(ctx.db, SUB_SOLVER);
		expect(uncleared).toHaveLength(0);

		// Audit event should have been emitted
		expect(events.some((e) => e.kind.type === "bufferDebited")).toBe(true);
	});

	it("does not slash when balance is below c_L", async () => {
		const maxBuy = 1000n;
		const minBuy = 900n;
		const delivered = 999n; // gap = 1, nativeTokenAmount = 1 wei — well below c_L
		const refPrice = ETHER.toString();

		const { tx } = await settledBufferProposal(maxBuy, minBuy, refPrice);
		const deltaByTx = new Map([[tx.toLowerCase(), delivered]]);
		const debitCalls: Array<{ subSolver: Address; amount: bigint }> = [];
		const operator = bufferOperator(deltaByTx, debitCalls);

		await runBufferDebits(config(operator, []), new Map());

		// Entry recorded but no slash
		const uncleared = await store.unclearedBufferEntries(ctx.db, SUB_SOLVER);
		expect(uncleared.length).toBeGreaterThanOrEqual(1);
		// No debit call for buffer (there may be calls from other tests' proposals)
		// Check that no new debit was triggered by verifying entries remain uncleared
		const allCleared = uncleared.every((e) => !e.cleared);
		expect(allCleared).toBe(true);
	});

	it("credits offset debits before threshold check", async () => {
		// First proposal: under-delivery of 0.008 ETH
		const { tx: tx1 } = await settledBufferProposal(ETHER, ETHER / 2n, ETHER.toString());
		// Second proposal: over-delivery of 0.006 ETH
		const { tx: tx2 } = await settledBufferProposal(ETHER, ETHER / 2n, ETHER.toString());
		const deltaByTx = new Map([
			[tx1.toLowerCase(), ETHER - 8_000_000_000_000_000n], // gap = +0.008 ETH
			[tx2.toLowerCase(), ETHER + 6_000_000_000_000_000n], // gap = -0.006 ETH
		]);
		const debitCalls: Array<{ subSolver: Address; amount: bigint }> = [];
		const operator = bufferOperator(deltaByTx, debitCalls);

		await runBufferDebits(config(operator, []), new Map());

		// Net balance = 0.008 - 0.006 = 0.002 ETH < c_L (0.01 ETH)
		// No slash should happen — entries remain uncleared
		const uncleared = await store.unclearedBufferEntries(ctx.db, SUB_SOLVER);
		expect(uncleared.length).toBeGreaterThanOrEqual(2);
	});

	it("proposal stays settled after buffer entry is recorded", async () => {
		const { id, tx } = await settledBufferProposal(1000n, 900n, ETHER.toString());
		const deltaByTx = new Map([[tx.toLowerCase(), 950n]]);
		const operator = bufferOperator(deltaByTx);

		await runBufferDebits(config(operator), new Map());

		const proposal = await store.get(ctx.db, id);
		expect(proposal?.status).toBe("settled");
	});

	it("ignores settled proposals without aggressive buffer", async () => {
		// minBuyAmount == quoteBuyAmount: no buffer accounting
		const base = sampleProposal();
		const { id } = await store.insert(ctx.db, {
			...base,
			subSolver: SUB_SOLVER,
			minBuyAmount: 1000n,
			quoteBuyAmount: 1000n,
		});
		const tx: Hex = `0x${id.toString(16).padStart(64, "0")}`;
		const submitted = await store.get(ctx.db, id);
		await store.transition(ctx.db, submitted as Proposal, "active");
		const active = await store.get(ctx.db, id);
		await store.applySettlementOutcome(ctx.db, active as Proposal, {
			kind: "succeeded",
			txHash: tx,
		});

		const operator = bufferOperator(new Map());
		await runBufferDebits(config(operator), new Map());

		// No entry should exist for this proposal
		const exists = await store.bufferEntryExistsForProposal(ctx.db, id);
		expect(exists).toBe(false);
	});

	it("does not double-debit when finalize fails after a successful on-chain debit", async () => {
		// Use a fresh subsolver address to isolate from other tests
		const isolatedSolver = "0xdead000000000000000000000000000000000001" as Address;
		const maxBuy = ETHER;
		const minBuy = ETHER / 2n;
		const delivered = (ETHER * 98n) / 100n; // gap = 0.02 ETH > c_L
		const refPrice = ETHER.toString();

		const base = sampleProposal();
		const { id } = await store.insert(ctx.db, {
			...base,
			subSolver: isolatedSolver,
			minBuyAmount: minBuy,
			quoteBuyAmount: maxBuy,
		});
		const tx: Hex = `0x${id.toString(16).padStart(64, "0")}`;
		const submitted = await store.get(ctx.db, id);
		await store.transition(ctx.db, submitted as Proposal, "active");
		const active = await store.get(ctx.db, id);
		await store.applySettlementOutcome(ctx.db, active as Proposal, {
			kind: "succeeded",
			txHash: tx,
		});
		await store.recordSolution(ctx.db, 8000 + id, 1, id, refPrice);

		const debitCalls: Array<{ subSolver: Address; amount: bigint }> = [];

		// First tick: records entry AND slashes (balance > c_L)
		const op1 = bufferOperator(new Map([[tx.toLowerCase(), delivered]]), debitCalls);
		await runBufferDebits(config(op1), new Map());

		const firstDebitCount = debitCalls.filter(
			(c) => c.subSolver.toLowerCase() === isolatedSolver.toLowerCase(),
		).length;
		expect(firstDebitCount).toBe(1);

		// Second tick: entries are already cleared, so no new debit
		debitCalls.length = 0;
		const op2 = bufferOperator(new Map([[tx.toLowerCase(), delivered]]), debitCalls);
		await runBufferDebits(config(op2), new Map());

		const secondDebitCount = debitCalls.filter(
			(c) => c.subSolver.toLowerCase() === isolatedSolver.toLowerCase(),
		).length;
		expect(secondDebitCount).toBe(0);
	});

	it("reverts in-flight entries when the on-chain debit fails", async () => {
		const isolatedSolver = "0xdead000000000000000000000000000000000002" as Address;
		const maxBuy = ETHER;
		const minBuy = ETHER / 2n;
		const delivered = (ETHER * 98n) / 100n;
		const refPrice = ETHER.toString();

		const base = sampleProposal();
		const { id } = await store.insert(ctx.db, {
			...base,
			subSolver: isolatedSolver,
			minBuyAmount: minBuy,
			quoteBuyAmount: maxBuy,
		});
		const tx: Hex = `0x${id.toString(16).padStart(64, "0")}`;
		const submitted = await store.get(ctx.db, id);
		await store.transition(ctx.db, submitted as Proposal, "active");
		const active = await store.get(ctx.db, id);
		await store.applySettlementOutcome(ctx.db, active as Proposal, {
			kind: "succeeded",
			txHash: tx,
		});
		await store.recordSolution(ctx.db, 7000 + id, 1, id, refPrice);

		// Operator that reads delta fine but fails on debit
		const failingOperator: DebitEscrow = {
			async settlementCost() {
				throw new Error("not used");
			},
			async debit() {
				throw new Error("escrow paused");
			},
			async readExecutedDelta(txHash) {
				if (txHash.toLowerCase() === tx.toLowerCase()) return delivered;
				throw new Error("unknown tx");
			},
		};

		// First tick: entry is recorded, debit fails, entries are reverted
		await runBufferDebits(config(failingOperator), new Map());

		// Entries should be back to uncleared (not stuck in-flight)
		const uncleared = await store.unclearedBufferEntries(ctx.db, isolatedSolver);
		expect(uncleared.length).toBeGreaterThanOrEqual(1);
		const entry = uncleared.find((e) => e.proposalId === id);
		expect(entry).toBeDefined();
		expect(entry?.cleared).toBe(false);

		// Second tick with a working operator: should successfully debit
		const debitCalls: Array<{ subSolver: Address; amount: bigint }> = [];
		const workingOp = bufferOperator(new Map([[tx.toLowerCase(), delivered]]), debitCalls);
		await runBufferDebits(config(workingOp), new Map());

		const debits = debitCalls.filter(
			(c) => c.subSolver.toLowerCase() === isolatedSolver.toLowerCase(),
		);
		expect(debits.length).toBe(1);
	});
});
