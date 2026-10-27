import { eq } from "drizzle-orm";
import pino from "pino";
import type { Address, Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestContext } from "../../../../test/setup.js";
import { createTestDb } from "../../../../test/setup.js";
import { bufferEntries, proposalsLog } from "../../../db/schema.js";
import type { AuditEvent } from "../../../domain/audit.js";
import type { DebitEscrow } from "../../../domain/penalty.js";
import type { Candidate } from "../../candidate-store.js";
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

const SUB_SOLVER = "0xe05fcc23807536bee418f142d19fa0d21bb0cff7" as Address;
const SELL_TOKEN = "0xb1f1ee126e9c96231cc3d3fad7c08b4cf873b1f1" as Address;
const BUY_TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address;
const TRAMPOLINE = "0x0000000000000000000000000000000000001234" as Address;
const ETHER = 10n ** 18n;

let idCounter = 1;
let nonceCounter = 0n;

const BASE_SOLUTION_PRICES: store.SolutionPrices = {
	sellTokenRefPrice: ETHER.toString(),
	surplusTokenRefPrice: ETHER.toString(),
	auctionGasPrice: "1000000000",
	clearingPrices: {},
};

function sampleCandidate(overrides?: Partial<Candidate>): Candidate {
	const uid = idCounter.toString(16).padStart(2, "0");
	return {
		id: idCounter++,
		subSolver: SUB_SOLVER,
		orderUid: `0x${uid.repeat(56)}`,
		orderUidHash: `0x${"cc".repeat(32)}` as Hex,
		sellAmount: 1_000_000n,
		minBuyAmount: 990_000n,
		quoteBuyAmount: 990_000n,
		sellToken: SELL_TOKEN,
		buyToken: BUY_TOKEN,
		interactions: [],
		interactionsHash: `0x${"dd".repeat(32)}` as Hex,
		validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600),
		nonce: nonceCounter++,
		signature: `0x${"ee".repeat(65)}` as Hex,
		auctionId: 1,
		gasUsed: 100_000n,
		trampoline: TRAMPOLINE,
		simulationBuyAmount: null,
		sellTokenRefPrice: ETHER.toString(),
		createdAt: new Date(),
		...overrides,
	};
}

/**
 * Inserts a proposal and drives it to settleFailed with a unique settlement tx.
 */
async function settleFailedProposal(): Promise<{ id: number; tx: Hex }> {
	const candidate = sampleCandidate();
	await store.insertAsSubmitted(ctx.db, candidate, ETHER.toString(), BASE_SOLUTION_PRICES);
	const tx: Hex = `0x${candidate.id.toString(16).padStart(64, "0")}`;
	const submitted = (await store.get(ctx.db, candidate.id))!;
	await store.applySettlementOutcome(ctx.db, submitted, { kind: "reverted", txHash: tx });
	return { id: candidate.id, tx };
}

function config(operator: DebitEscrow | LegacyDebitEscrow, events: AuditEvent[] = []) {
	return {
		db: ctx.db,
		operator: "debit" in operator ? durableTestOperator(operator) : operator,
		collateralRatioBps: 0n,
		minCollateral: C_L,
		workerId: "test-worker",
		onAuditEvent: (event: AuditEvent) => {
			events.push(event);
		},
		logger,
	};
}

type LegacyDebitEscrow = Omit<
	DebitEscrow,
	"signDebit" | "broadcastSignedDebit" | "debitOutcome"
> & {
	debit(subSolver: Address, amount: bigint, reason: Hex): Promise<Hex>;
	testDebitHash?: Hex;
};

function durableTestOperator(operator: LegacyDebitEscrow): DebitEscrow {
	const hash = operator.testDebitHash ?? PENALTY_TX;
	const rawTransaction = `0x${"ab".repeat(96)}` as Hex;
	let landed = false;

	return {
		settlementCost: operator.settlementCost,
		readExecutedDelta: operator.readExecutedDelta,
		async signDebit(subSolver, amount, reason) {
			await operator.debit(subSolver, amount, reason);
			landed = true;
			return { rawTransaction, hash };
		},
		async broadcastSignedDebit() {
			return hash;
		},
		async debitOutcome() {
			return landed ? "succeeded" : null;
		},
	};
}

describe("revert debits", () => {
	it("a successor claims an expired lease and broadcasts persisted debit bytes without signing", async () => {
		const { id, tx } = await settleFailedProposal();
		const raw = `0x${"12".repeat(96)}` as Hex;
		const debitHash = `0x${"34".repeat(32)}` as Hex;
		let signCalls = 0;
		const broadcasts: Hex[] = [];
		let landed = false;
		const proposal = await store.getIncludingLog(ctx.db, id);
		const operation = await store.createDebitOperation(ctx.db, {
			sourceKind: "revert",
			sourceId: `proposal:${id}`,
			subSolver: proposal?.subSolver as Address,
			amount: 500n + C_L,
			reason: tx,
		});
		await store.claimDebitOperation(ctx.db, operation.id, "replica-a", 0);
		await store.persistSignedDebit(ctx.db, operation.id, "replica-a", raw, debitHash);
		const operator: DebitEscrow = {
			async settlementCost() {
				return 500n;
			},
			async signDebit() {
				signCalls++;
				return { rawTransaction: raw, hash: debitHash };
			},
			async broadcastSignedDebit(bytes) {
				broadcasts.push(bytes);
				landed = true;
				return debitHash;
			},
			async debitOutcome() {
				return landed ? "succeeded" : null;
			},
			async readExecutedDelta() {
				throw new Error("not used");
			},
		};

		// Replica A persisted the only signed transaction then crashed. Its
		// zero-second lease is expired, so replica B must use those same bytes.
		await runRevertDebits({ ...config(operator), workerId: "replica-b" }, new Map());
		const after = await store.getIncludingLog(ctx.db, id);
		expect(after?.status).toBe("settleFailed");
		expect(after?.penaltyTxHash).toBe(debitHash);
		expect(signCalls).toBe(0);
		expect(broadcasts).toEqual([raw]);
		expect(tx).toBeDefined();
	});

	it("parks a durable operation after ten failures even when each tick has a new worker", async () => {
		const { id } = await settleFailedProposal();
		const raw = `0x${"56".repeat(96)}` as Hex;
		const debitHash = `0x${"78".repeat(32)}` as Hex;
		let signCalls = 0;
		let broadcasts = 0;
		const operator: DebitEscrow = {
			async settlementCost() {
				return 500n;
			},
			async signDebit() {
				signCalls++;
				return { rawTransaction: raw, hash: debitHash };
			},
			async broadcastSignedDebit() {
				broadcasts++;
				return debitHash;
			},
			async debitOutcome() {
				return null;
			},
			async readExecutedDelta() {
				throw new Error("not used");
			},
		};

		for (let tick = 0; tick < 12; tick++) {
			await runRevertDebits({ ...config(operator), workerId: `replica-${tick}` }, new Map());
		}

		expect((await store.getIncludingLog(ctx.db, id))?.status).toBe("settleFailed");
		expect(signCalls).toBe(1);
		expect(broadcasts).toBe(10);
	});

	it("debits a settleFailed proposal and records penalty_tx_hash", async () => {
		const { id, tx } = await settleFailedProposal();
		const calls: { subSolver: Address; amount: bigint; reason: Hex }[] = [];
		const operator: LegacyDebitEscrow = {
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
		const proposal = await store.getIncludingLog(ctx.db, id);
		expect(proposal?.status).toBe("settleFailed");
		expect(proposal?.penaltyTxHash).toBe(PENALTY_TX);
		expect(events.some((e) => e.kind.type === "penalized" && e.kind.proposalId === id)).toBe(true);
	});

	it("keeps a proposal settleFailed across failed ticks until a debit lands", async () => {
		const { id, tx } = await settleFailedProposal();
		let debitCalls = 0;
		const flaky: LegacyDebitEscrow = {
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
		expect((await store.getIncludingLog(ctx.db, id))?.penaltyTxHash).toBeNull();

		await runRevertDebits(config(flaky), attempts);
		const after = await store.getIncludingLog(ctx.db, id);
		expect(after?.status).toBe("settleFailed");
		expect(after?.penaltyTxHash).toBe(PENALTY_TX);
		expect(debitCalls).toBe(3);
		expect(attempts.size).toBe(0);
	});

	it("gives up on a permanently failing revert debit after the attempt cap", async () => {
		const { id, tx } = await settleFailedProposal();
		let debitCalls = 0;
		const dead: LegacyDebitEscrow = {
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
		expect((await store.getIncludingLog(ctx.db, id))?.status).toBe("settleFailed");
	});

	it("stops looking up a permanently unpriceable settlement", async () => {
		const { tx } = await settleFailedProposal();
		let costCalls = 0;
		let debitCalls = 0;
		const unpriceable: LegacyDebitEscrow = {
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
		const candidate = sampleCandidate();
		await store.insertAsSubmitted(ctx.db, candidate, ETHER.toString(), BASE_SOLUTION_PRICES);
		const submitted = (await store.get(ctx.db, candidate.id))!;
		await store.transition(ctx.db, submitted, "settleFailed");
		const id = candidate.id;

		const operator: LegacyDebitEscrow = {
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
		const operator: LegacyDebitEscrow = {
			async settlementCost() {
				return 500n;
			},
			// The debit lands, but a concurrent worker already set penalty_tx_hash —
			// recordPenalty's idempotency guard (penalty_tx_hash IS NULL) blocks it.
			async debit(_subSolver, _amount, reason) {
				if (reason !== tx) return PENALTY_TX;
				await ctx.db
					.update(proposalsLog)
					.set({ penaltyTxHash: `0x${"aa".repeat(32)}` })
					.where(eq(proposalsLog.id, id));
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
		const candidate = sampleCandidate();
		await store.insertAsSubmitted(ctx.db, candidate, ETHER.toString(), BASE_SOLUTION_PRICES);
		await store.applyLostOutcome(ctx.db, candidate.id, "UnknownOutput");
		return candidate.id;
	}

	it("debits a queued penalty at 0.1 c_l exactly once", async () => {
		const proposalId = await queuedPenalty();
		const calls: bigint[] = [];
		const operator: LegacyDebitEscrow = {
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
		// penalty_tx_hash is now set; proposal stays lost in proposals_log
		const after = await store.getIncludingLog(ctx.db, proposalId);
		expect(after?.status).toBe("lost");
		expect(after?.penaltyTxHash).toBe(PENALTY_TX);
	});

	it("gives up on a permanently failing non-settlement debit after the cap", async () => {
		await queuedPenalty();
		let debitCalls = 0;
		const dead: LegacyDebitEscrow = {
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
	const CLEAR_TX: Hex = `0x${"88".repeat(32)}`;

	/** Creates a settled proposal with buy-token ref price already on the row. */
	async function settledBufferProposal(
		quoteBuyAmount: bigint,
		minBuyAmount: bigint,
		buyTokenRefPrice: string,
		subSolver: Address = SUB_SOLVER,
	): Promise<{ id: number; tx: Hex }> {
		const candidate = sampleCandidate({
			subSolver,
			minBuyAmount,
			quoteBuyAmount,
		});
		await store.insertAsSubmitted(ctx.db, candidate, buyTokenRefPrice, {
			...BASE_SOLUTION_PRICES,
			sellTokenRefPrice: ETHER.toString(),
		});
		const tx: Hex = `0x${candidate.id.toString(16).padStart(64, "0")}`;
		const submitted = (await store.get(ctx.db, candidate.id))!;
		await store.applySettlementOutcome(ctx.db, submitted, { kind: "succeeded", txHash: tx });
		return { id: candidate.id, tx };
	}

	function bufferOperator(
		deltaByTx: Map<string, bigint>,
		debitCalls: Array<{ subSolver: Address; amount: bigint }> = [],
	): LegacyDebitEscrow {
		return {
			testDebitHash: CLEAR_TX,
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
		expect(BigInt(entry!.nativeTokenAmount)).toBe(50n); // gap * 1e18 / 1e18 = 50
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
		expect(BigInt(entry!.nativeTokenAmount)).toBe(-50n);
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
		// Create a proposal with a gap large enough to exceed the buffer threshold (MIN_COLLATERAL/5 = 0.002 ETH)
		const maxBuy = ETHER; // 1e18
		const minBuy = ETHER / 2n;
		// delivered = 0.98e18, gap = 0.02e18. With ref price = 1 ETH/token,
		// nativeTokenAmount = 0.02 ETH > threshold (0.002 ETH).
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
		// Check that entries remain uncleared (not cleared)
		const allUncleared = uncleared.every((e) => !e.cleared);
		expect(allUncleared).toBe(true);
	});

	it("credits offset debits before threshold check", async () => {
		// First proposal: under-delivery of 0.0008 ETH
		const { tx: tx1 } = await settledBufferProposal(ETHER, ETHER / 2n, ETHER.toString());
		// Second proposal: over-delivery of 0.0006 ETH
		const { tx: tx2 } = await settledBufferProposal(ETHER, ETHER / 2n, ETHER.toString());
		const deltaByTx = new Map([
			[tx1.toLowerCase(), ETHER - 800_000_000_000_000n], // gap = +0.0008 ETH
			[tx2.toLowerCase(), ETHER + 600_000_000_000_000n], // gap = -0.0006 ETH
		]);
		const debitCalls: Array<{ subSolver: Address; amount: bigint }> = [];
		const operator = bufferOperator(deltaByTx, debitCalls);

		await runBufferDebits(config(operator, []), new Map());

		// Net balance = 0.0008 - 0.0006 = 0.0002 ETH < buffer threshold (MIN_COLLATERAL/5 = 0.002 ETH)
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
		const candidate = sampleCandidate({
			minBuyAmount: 1000n,
			quoteBuyAmount: 1000n,
		});
		await store.insertAsSubmitted(ctx.db, candidate, ETHER.toString(), BASE_SOLUTION_PRICES);
		const tx: Hex = `0x${candidate.id.toString(16).padStart(64, "0")}`;
		const submitted = (await store.get(ctx.db, candidate.id))!;
		await store.applySettlementOutcome(ctx.db, submitted, { kind: "succeeded", txHash: tx });

		const operator = bufferOperator(new Map());
		await runBufferDebits(config(operator), new Map());

		// No entry should exist for this proposal
		const exists = await store.bufferEntryExistsForProposal(ctx.db, candidate.id);
		expect(exists).toBe(false);
	});

	it("does not double-debit when finalize fails after a successful on-chain debit", async () => {
		// Use a fresh subsolver address to isolate from other tests
		const isolatedSolver = "0xdead000000000000000000000000000000000001" as Address;
		const maxBuy = ETHER;
		const minBuy = ETHER / 2n;
		const delivered = (ETHER * 98n) / 100n; // gap = 0.02 ETH > c_L
		const refPrice = ETHER.toString();

		const { id, tx } = await settledBufferProposal(maxBuy, minBuy, refPrice, isolatedSolver);

		const raw = `0x${"ab".repeat(96)}` as Hex;
		let signCalls = 0;
		let broadcasts = 0;
		let landed = false;
		const operator: DebitEscrow = {
			async settlementCost() {
				throw new Error("not used");
			},
			async signDebit() {
				signCalls++;
				return { rawTransaction: raw, hash: CLEAR_TX };
			},
			async broadcastSignedDebit() {
				broadcasts++;
				landed = true;
				return CLEAR_TX;
			},
			async debitOutcome() {
				return landed ? "succeeded" : null;
			},
			async readExecutedDelta(txHash) {
				if (txHash.toLowerCase() === tx.toLowerCase()) return delivered;
				throw new Error("unknown tx");
			},
		};

		const finalize = vi
			.spyOn(store, "finalizeBufferEntries")
			.mockRejectedValueOnce(new Error("database unavailable"));
		try {
			await runBufferDebits(config(operator), new Map());
		} finally {
			finalize.mockRestore();
		}
		expect(broadcasts).toBe(1);

		await runBufferDebits(config(operator), new Map());
		expect(signCalls).toBe(1);
		expect(broadcasts).toBe(1);
		// Suppress unused variable warning
		void id;
	});

	it("recovers an in-flight buffer debit without rebuilding the charge", async () => {
		const isolatedSolver = "0xdead000000000000000000000000000000000002" as Address;
		const maxBuy = ETHER;
		const minBuy = ETHER / 2n;
		const delivered = (ETHER * 98n) / 100n;
		const refPrice = ETHER.toString();

		const { id, tx } = await settledBufferProposal(maxBuy, minBuy, refPrice, isolatedSolver);

		// Operator that reads delta fine but fails on debit
		const failingOperator: LegacyDebitEscrow = {
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

		// First tick: entry is recorded and the durable operation is retained.
		await runBufferDebits(config(failingOperator), new Map());

		// In-flight entries stay excluded: a retry must recover the same debit
		// operation, not construct a replacement charge from the balance.
		const uncleared = await store.unclearedBufferEntries(ctx.db, isolatedSolver);
		expect(uncleared.find((e) => e.proposalId === id)).toBeUndefined();

		// Second tick with a working operator: should successfully debit
		const debitCalls: Array<{ subSolver: Address; amount: bigint }> = [];
		const workingOp = bufferOperator(new Map([[tx.toLowerCase(), delivered]]), debitCalls);
		await runBufferDebits(config(workingOp), new Map());

		const debits = debitCalls.filter(
			(c) => c.subSolver.toLowerCase() === isolatedSolver.toLowerCase(),
		);
		expect(debits.length).toBe(1);
	});

	it("recovers a buffer operation created before its entries were marked in-flight", async () => {
		const isolatedSolver = "0xdead000000000000000000000000000000000003" as Address;
		const candidate = sampleCandidate({ subSolver: isolatedSolver });
		await store.insertAsSubmitted(ctx.db, candidate, ETHER.toString(), BASE_SOLUTION_PRICES);
		const id = candidate.id;
		const orderUid = candidate.orderUid;
		const entryId = await store.insertBufferEntry(ctx.db, {
			subSolver: isolatedSolver,
			proposalId: id,
			orderUid,
			buyToken: BUY_TOKEN,
			delta: "1",
			gap: "1",
			nativeTokenAmount: (C_L + 1n).toString(),
		});
		await store.createDebitOperation(ctx.db, {
			sourceKind: "buffer",
			sourceId: `subsolver:${isolatedSolver}:entries:${entryId}`,
			subSolver: isolatedSolver,
			amount: C_L + 1n,
			reason: `0x${"00".repeat(32)}`,
		});

		const debitCalls: Array<{ subSolver: Address; amount: bigint }> = [];
		await runBufferDebits(config(bufferOperator(new Map(), debitCalls)), new Map());

		const [entry] = await ctx.db
			.select({ cleared: bufferEntries.cleared, clearTxHash: bufferEntries.clearTxHash })
			.from(bufferEntries)
			.where(eq(bufferEntries.id, entryId));
		expect(entry).toEqual({ cleared: true, clearTxHash: CLEAR_TX });
		expect(debitCalls).toContainEqual({ subSolver: isolatedSolver, amount: C_L + 1n });
	});

	it("finalizes only the buffer entries belonging to the durable operation", async () => {
		const isolatedSolver = "0xdead000000000000000000000000000000000004" as Address;
		const c1 = sampleCandidate({ subSolver: isolatedSolver });
		const c2 = sampleCandidate({ subSolver: isolatedSolver });
		await store.insertAsSubmitted(ctx.db, c1, ETHER.toString(), BASE_SOLUTION_PRICES);
		await store.insertAsSubmitted(ctx.db, c2, ETHER.toString(), BASE_SOLUTION_PRICES);
		const firstEntryId = await store.insertBufferEntry(ctx.db, {
			subSolver: isolatedSolver,
			proposalId: c1.id,
			orderUid: c1.orderUid,
			buyToken: BUY_TOKEN,
			delta: "1",
			gap: "1",
			nativeTokenAmount: "1",
		});
		const secondEntryId = await store.insertBufferEntry(ctx.db, {
			subSolver: isolatedSolver,
			proposalId: c2.id,
			orderUid: c2.orderUid,
			buyToken: BUY_TOKEN,
			delta: "1",
			gap: "1",
			nativeTokenAmount: "1",
		});
		await store.markBufferEntriesInFlight(ctx.db, isolatedSolver, [firstEntryId, secondEntryId]);

		expect(
			await store.finalizeBufferEntries(ctx.db, isolatedSolver, [firstEntryId], CLEAR_TX),
		).toBe(1);
		expect(
			await store.finalizeBufferEntries(ctx.db, isolatedSolver, [secondEntryId], PENALTY_TX),
		).toBe(1);
	});
});

describe("pending penalty debit after loss", () => {
	it("debits a queued penalty and clears it", async () => {
		const isolated = await createTestDb();
		try {
			// Insert a candidate, drive it to lost — penalty_tx_hash starts NULL
			const candidate = sampleCandidate();
			await store.insertAsSubmitted(isolated.db, candidate, ETHER.toString(), BASE_SOLUTION_PRICES);
			await store.applyLostOutcome(isolated.db, candidate.id, "UnknownOutput");

			let landed = false;
			const operator: DebitEscrow = {
				settlementCost: async () => 0n,
				readExecutedDelta: async () => 0n,
				signDebit: async () => {
					landed = true;
					return { rawTransaction: "0xab", hash: PENALTY_TX };
				},
				broadcastSignedDebit: async () => {
					return PENALTY_TX;
				},
				debitOutcome: async () => (landed ? "succeeded" : null),
			};
			const worker = { ...config(operator), db: isolated.db };
			await runNonSettlementDebits(worker, new Map());
			expect(await store.pendingPenalties(isolated.db)).toHaveLength(0);
		} finally {
			await isolated.cleanup();
		}
	});
});
