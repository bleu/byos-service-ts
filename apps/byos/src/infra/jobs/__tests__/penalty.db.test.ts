import pino from "pino";
import type { Address, Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestContext } from "../../../../test/setup.js";
import { createTestDb } from "../../../../test/setup.js";
import type { AuditEvent } from "../../../domain/audit.js";
import type { DebitEscrow } from "../../../domain/penalty.js";
import type { Proposal } from "../../../domain/proposal.js";
import * as store from "../../storage.js";
import { runNonSettlementDebits, runRevertDebits } from "../penalty.js";

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
		buyAmount: 990_000n,
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
		};
		const attempts = new Map<number, number>();

		for (let tick = 0; tick < 12; tick++) {
			await runRevertDebits(config(unpriceable), attempts);
		}

		expect(costCalls).toBe(10);
		expect(debitCalls).toBe(0);
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
		};
		const attempts = new Map<number, number>();

		for (let tick = 0; tick < 12; tick++) {
			await runNonSettlementDebits(config(dead), attempts);
		}

		expect(debitCalls).toBe(10);
		expect(await store.pendingPenalties(ctx.db)).not.toHaveLength(0);
	});
});
