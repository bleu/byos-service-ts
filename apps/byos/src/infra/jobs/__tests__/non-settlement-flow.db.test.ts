import { eq, sql } from "drizzle-orm";
import pino from "pino";
import type { Hex, PublicClient } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestContext } from "../../../../test/setup.js";
import {
	debitOperations,
	proposals,
	settlementAttempts,
	settlementNotifications,
} from "../../../db/schema.js";
import type { DebitEscrow } from "../../../domain/penalty.js";
import { createNotifyRoute } from "../../api/notify.js";
import type { Candidate } from "../../candidate-store.js";
import { recordSettlementNotification } from "../../settlement-attempts.js";
import * as store from "../../storage.js";
import { runOutcomeCheck } from "../outcome-worker.js";
import {
	nonSettlementReason,
	type PenaltyWorkerConfig,
	runNonSettlementDebits,
	runRevertDebits,
} from "../penalty.js";

let ctx: TestContext;
const logger = pino({ level: "silent" });
const subSolver = "0x0101010101010101010101010101010101010101" as const;
const hash = `0x${"aa".repeat(32)}` as Hex;
const cap = 10_000n;
let nextId = 1;
beforeEach(async () => {
	ctx = await createTestDb();
});
afterEach(async () => {
	await ctx.cleanup();
});

async function bid(): Promise<number> {
	const id = nextId++;
	const candidate: Candidate = {
		id,
		auctionId: 42,
		subSolver,
		orderUid: `0x${id.toString(16).padStart(112, "0")}`,
		orderUidHash: hash,
		sellAmount: 100n,
		minBuyAmount: 90n,
		quoteBuyAmount: 90n,
		sellToken: subSolver,
		buyToken: subSolver,
		interactions: [],
		interactionsHash: hash,
		validUntil: 9999999999n,
		nonce: BigInt(id),
		signature: "0xab",
		gasUsed: 100n,
		trampoline: subSolver,
		simulationBuyAmount: null,
		sellTokenRefPrice: "1000000000000000000",
		createdAt: new Date(),
	};
	await store.insertAsSubmitted(ctx.db, candidate, "1000000000000000000", {
		sellTokenRefPrice: "1000000000000000000",
		surplusTokenRefPrice: "1000000000000000000",
		auctionGasPrice: "1",
		clearingPrices: {},
	});
	await ctx.db
		.update(proposals)
		.set({ settlementPenaltyCap: cap.toString() })
		.where(eq(proposals.id, id));
	return id;
}
async function notify(id: number | number[], kind: string, auctionId = "42") {
	const route = createNotifyRoute({ db: ctx.db, logger, onAuditEvent: () => {} });
	const response = await route.request("/notify", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			auctionId,
			solutionId: id,
			kind,
			...(["success", "revert"].includes(kind) ? { transaction: hash } : {}),
		}),
	});
	expect(response.status).toBe(200);
}
function worker() {
	const sign = vi.fn(async () => ({ rawTransaction: "0xab" as Hex, hash }));
	let broadcast = false;
	const operator: DebitEscrow = {
		signDebit: sign,
		broadcastSignedDebit: vi.fn(async () => {
			broadcast = true;
			return hash;
		}),
		debitOutcome: async () => (broadcast ? "succeeded" : null),
		settlementCost: async () => 0n,
		readExecutedDelta: async () => 0n,
	};
	const config: PenaltyWorkerConfig = {
		db: ctx.db,
		operator,
		collateralRatioBps: 4n,
		minCollateral: 999999n,
		workerId: crypto.randomUUID(),
		logger,
		onAuditEvent: () => {},
	};
	return { config, sign };
}
async function debit() {
	const w = worker();
	await runNonSettlementDebits(w.config, new Map());
	return w;
}

describe("non-settlement authorization", () => {
	it.each([false, true])(
		"never charges outcome reconciliation (trade found: %s)",
		async (filled) => {
			const id = await bid();
			await ctx.db
				.update(proposals)
				.set({ statusChangedAt: sql`now() - interval '3 minutes'` })
				.where(eq(proposals.id, id));
			const proposal = (await store.get(ctx.db, id))!;
			await runOutcomeCheck({
				db: ctx.db,
				publicClient: {
					getBlockNumber: async () => 1000n,
					getLogs: async () => (filled ? [{ args: { orderUid: proposal.orderUid } }] : []),
				} as unknown as PublicClient,
				settlementAddress: subSolver,
				blockDurationMs: 1000,
				logger,
				onAuditEvent: () => {},
			});
			expect((await store.getIncludingLog(ctx.db, id))?.status).toBe("lost");
			expect((await debit()).sign).not.toHaveBeenCalled();
		},
	);
	it.each(["cancelled", "expired", "fail"])(
		"requires start evidence before charging %s",
		async (kind) => {
			const id = await bid();
			await notify(id, kind);
			expect((await debit()).sign).not.toHaveBeenCalled();
		},
	);
	it("charges a confirmed abandonment exactly once using the snapshotted cap", async () => {
		const id = await bid();
		await notify(id, "settlementStarted");
		await notify(id, "fail");
		await notify(id, "fail");
		const w = await debit();
		expect(w.sign).toHaveBeenCalledExactlyOnceWith(subSolver, cap / 10n, expect.any(String));
		await runNonSettlementDebits({ ...w.config, workerId: "successor" }, new Map());
		expect(w.sign).toHaveBeenCalledTimes(1);
	});
	it("accepts abandonment before start without losing the evidence", async () => {
		const id = await bid();
		await notify(id, "expired");
		await notify(id, "settlementStarted");
		expect((await debit()).sign).toHaveBeenCalledTimes(1);
	});
	it.each(["success", "revert"])(
		"cancels an unbroadcast abandonment charge on late %s",
		async (kind) => {
			const id = await bid();
			await notify(id, "settlementStarted");
			await notify(id, "fail");
			await notify(id, kind);
			expect((await debit()).sign).not.toHaveBeenCalled();
		},
	);
	it("does not join start evidence from a different auction", async () => {
		const id = await bid();
		await notify(id, "settlementStarted", "43");
		await notify(id, "fail");
		expect((await debit()).sign).not.toHaveBeenCalled();
	});
	it("does not charge an abandonment with no cap snapshot", async () => {
		const id = await bid();
		await ctx.db.update(proposals).set({ settlementPenaltyCap: null }).where(eq(proposals.id, id));
		await notify(id, "settlementStarted");
		await notify(id, "fail");
		expect((await debit()).sign).not.toHaveBeenCalled();
	});
});

async function attemptFor(proposalId: number) {
	const [attempt] = await ctx.db
		.select()
		.from(settlementAttempts)
		.where(eq(settlementAttempts.proposalId, proposalId));
	if (!attempt) throw new Error("missing settlement attempt");
	return attempt;
}

describe("durable non-settlement execution", () => {
	it("deduplicates concurrent notifications and workers across instances", async () => {
		const id = await bid();
		await Promise.all(Array.from({ length: 4 }, () => notify(id, "settlementStarted")));
		await Promise.all(Array.from({ length: 4 }, () => notify(id, "cancelled")));
		const attempt = await attemptFor(id);
		const evidence = await ctx.db
			.select()
			.from(settlementNotifications)
			.where(eq(settlementNotifications.attemptId, attempt.id));
		expect(evidence).toHaveLength(2);
		const w = worker();
		await Promise.all([
			runNonSettlementDebits(w.config, new Map()),
			runNonSettlementDebits({ ...w.config, workerId: "other-replica" }, new Map()),
		]);
		expect(w.sign).toHaveBeenCalledTimes(1);
		expect((await attemptFor(id)).status).toBe("debited");
	});
	it("recovers signed bytes on restart without repricing or signing again", async () => {
		const id = await bid();
		await notify(id, "settlementStarted");
		await notify(id, "fail");
		const w = worker();
		w.config.operator.debitOutcome = async () => null;
		await runNonSettlementDebits(w.config, new Map());
		expect(w.sign).toHaveBeenCalledTimes(1);
		const successor = worker();
		successor.config.operator.debitOutcome = async () => "succeeded";
		await runNonSettlementDebits(successor.config, new Map());
		expect(successor.sign).not.toHaveBeenCalled();
		const attempt = await attemptFor(id);
		expect(attempt.status).toBe("debited");
		expect(attempt.amount).toBe((cap / 10n).toString());
	});
	it.each([false, true])(
		"records a reconciliation case when a late success conflicts with a debit (landed: %s)",
		async (landed) => {
			const id = await bid();
			await notify(id, "settlementStarted");
			await notify(id, "fail");
			const w = worker();
			if (!landed) w.config.operator.debitOutcome = async () => null;
			await runNonSettlementDebits(w.config, new Map());
			await notify(id, "success");
			const attempt = await attemptFor(id);
			expect(attempt.status).toBe("needs_reconciliation");
			expect(attempt.outcome).toBe("success");
			expect(attempt.reconciliationReason).toContain("signed or landed");
			expect((await debit()).sign).not.toHaveBeenCalled();
		},
	);
	it("does not charge multiple members of an unexpected merged settlement", async () => {
		const a = await bid();
		const b = await bid();
		await notify([b, a], "settlementStarted");
		await notify([a, b], "fail");
		expect((await debit()).sign).not.toHaveBeenCalled();
		const attempt = await attemptFor(a);
		expect(attempt.status).toBe("needs_reconciliation");
		expect(attempt.reconciliationReason).toBe("Unexpected merged settlement");
	});
	it("blocks overlapping single and merged notifications from generating extra charges", async () => {
		const a = await bid();
		const b = await bid();
		await notify(a, "settlementStarted");
		await notify([a, b], "settlementStarted");
		await notify(a, "fail");
		expect((await debit()).sign).not.toHaveBeenCalled();
		expect((await attemptFor(a)).status).toBe("needs_reconciliation");
		const evidence = await ctx.db
			.select()
			.from(settlementNotifications)
			.where(eq(settlementNotifications.attemptId, (await attemptFor(a)).id));
		expect(evidence.filter((event) => event.kind === "settlementStarted")).toHaveLength(2);
	});
	it("keeps evidence and eligibility after the proposal is swept by timeout", async () => {
		const id = await bid();
		await notify(id, "settlementStarted");
		await store.applyLostOutcome(ctx.db, id, "UnknownOutput");
		await notify(id, "expired");
		expect((await debit()).sign).toHaveBeenCalledTimes(1);
	});
	it("does not partially attribute a notification with an unknown member", async () => {
		const id = await bid();
		await notify([id, 999999], "settlementStarted");
		await notify(id, "fail");
		expect((await debit()).sign).not.toHaveBeenCalled();
	});
	it("uses the bid's cap snapshot even if a later price or config differs", async () => {
		const id = await bid();
		await notify(id, "settlementStarted");
		await ctx.db
			.update(proposals)
			.set({ settlementPenaltyCap: "999999999" })
			.where(eq(proposals.id, id));
		await notify(id, "fail");
		expect((await debit()).sign).toHaveBeenCalledExactlyOnceWith(
			subSolver,
			cap / 10n,
			expect.any(String),
		);
	});
});

describe("non-settlement finalization and legacy protection", () => {
	it("recovers a landed debit after financial finalization rolls back", async () => {
		const id = await bid();
		await notify(id, "settlementStarted");
		await notify(id, "fail");
		await ctx.db.execute(
			sql`CREATE FUNCTION reject_penalty_finalization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected finalization failure'; END $$`,
		);
		await ctx.db.execute(
			sql`CREATE TRIGGER reject_penalty_finalization BEFORE UPDATE OF penalty_tx_hash ON proposals_log FOR EACH ROW EXECUTE FUNCTION reject_penalty_finalization()`,
		);
		const first = worker();
		try {
			await runNonSettlementDebits(first.config, new Map());
		} finally {
			await ctx.db.execute(sql`DROP TRIGGER reject_penalty_finalization ON proposals_log`);
			await ctx.db.execute(sql`DROP FUNCTION reject_penalty_finalization()`);
		}
		expect(first.sign).toHaveBeenCalledTimes(1);
		expect((await attemptFor(id)).status).toBe("eligible");
		// A crashed worker retains its lease; the successor recovers after expiry.
		await ctx.db
			.update(debitOperations)
			.set({ leaseExpiresAt: sql`now() - interval '1 second'` })
			.where(eq(debitOperations.sourceId, `attempt:${(await attemptFor(id)).id}`));
		const second = worker();
		second.config.operator.debitOutcome = async () => "succeeded";
		await runNonSettlementDebits(second.config, new Map());
		expect(second.sign).not.toHaveBeenCalled();
		expect((await attemptFor(id)).status).toBe("debited");
		const operations = await ctx.db
			.select()
			.from(debitOperations)
			.where(eq(debitOperations.sourceId, `attempt:${(await attemptFor(id)).id}`));
		expect(operations).toHaveLength(1);
		expect(operations[0]?.status).toBe("completed");
	});
	it("does not reauthorize an already recorded legacy charge", async () => {
		const id = await bid();
		await ctx.db.update(proposals).set({ penaltyTxHash: hash }).where(eq(proposals.id, id));
		await notify(id, "settlementStarted");
		await notify(id, "fail");
		expect((await debit()).sign).not.toHaveBeenCalled();
		expect((await attemptFor(id)).reconciliationReason).toContain("Legacy");
	});
	it("does not reauthorize a signed legacy operation with an unknown outcome", async () => {
		const id = await bid();
		const proposal = (await store.get(ctx.db, id))!;
		const operation = await store.createDebitOperation(ctx.db, {
			sourceKind: "non-settlement",
			sourceId: `penalty:${id}`,
			subSolver,
			amount: cap / 10n,
			reason: nonSettlementReason(proposal.orderUid),
		});
		await store.claimDebitOperation(ctx.db, operation.id, "legacy", 60);
		await store.persistSignedDebit(ctx.db, operation.id, "legacy", "0xab", hash);
		await notify(id, "settlementStarted");
		await notify(id, "fail");
		expect((await debit()).sign).not.toHaveBeenCalled();
		expect((await attemptFor(id)).reconciliationReason).toContain("Legacy");
	});
	it("serializes an outcome correction with an in-flight debit", async () => {
		const id = await bid();
		await notify(id, "settlementStarted");
		await notify(id, "fail");
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const signing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const w = worker();
		w.sign.mockImplementation(async () => {
			entered();
			await gate;
			return { rawTransaction: "0xab", hash };
		});
		const running = runNonSettlementDebits(w.config, new Map());
		await signing;
		const correction = notify(id, "success");
		release();
		await Promise.all([running, correction]);
		expect(w.sign).toHaveBeenCalledTimes(1);
		expect((await attemptFor(id)).status).toBe("needs_reconciliation");
		expect((await debit()).sign).not.toHaveBeenCalled();
	});
});

it.each(["success", "revert"])(
	"preserves settlement accounting when abandonment races with %s",
	async (kind) => {
		const id = await bid();
		await notify(id, "settlementStarted");
		await Promise.all([notify(id, "fail"), notify(id, kind)]);
		expect((await store.getIncludingLog(ctx.db, id))?.status).toBe(
			kind === "success" ? "settled" : "settleFailed",
		);
		expect((await debit()).sign).not.toHaveBeenCalled();
	},
);

it("does not charge a revert while a signed abandonment debit needs reconciliation", async () => {
	const id = await bid();
	await notify(id, "settlementStarted");
	await notify(id, "fail");
	const first = worker();
	first.config.operator.debitOutcome = async () => null;
	await runNonSettlementDebits(first.config, new Map());
	expect(first.sign).toHaveBeenCalledTimes(1);
	await notify(id, "revert");
	const second = worker();
	await runRevertDebits(second.config, new Map());
	expect(second.sign).not.toHaveBeenCalled();
});

it("charges the revert instead when the abandonment debit was never signed", async () => {
	const id = await bid();
	await notify(id, "settlementStarted");
	await notify(id, "fail");
	await notify(id, "revert");
	const w = worker();
	await runNonSettlementDebits(w.config, new Map());
	await runRevertDebits(w.config, new Map());
	expect(w.sign).toHaveBeenCalledExactlyOnceWith(subSolver, cap, hash);
});

it("preserves a landed debit hash if the live proposal is transitioned afterwards", async () => {
	const id = await bid();
	// Persist the financial evidence before the independent lifecycle write.
	await recordSettlementNotification(ctx.db, {
		auctionId: "42",
		solutionId: id,
		kind: "settlementStarted",
	});
	await recordSettlementNotification(ctx.db, { auctionId: "42", solutionId: id, kind: "fail" });
	expect((await debit()).sign).toHaveBeenCalledTimes(1);
	await store.applyLostOutcome(ctx.db, id, "UnknownOutput");
	expect((await store.getIncludingLog(ctx.db, id))?.penaltyTxHash).toBe(hash);
});

it("resumes an exhausted attempt only while its abandonment evidence remains valid", async () => {
	const id = await bid();
	await notify(id, "settlementStarted");
	await notify(id, "fail");
	const w = worker();
	w.sign.mockRejectedValue(new Error("RPC unavailable"));
	for (let i = 0; i < 10; i++) await runNonSettlementDebits(w.config, new Map());
	const attempt = await attemptFor(id);
	expect(attempt.status).toBe("needs_reconciliation");
	const [operation] = await ctx.db
		.select()
		.from(debitOperations)
		.where(eq(debitOperations.sourceId, `attempt:${attempt.id}`));
	if (!operation) throw new Error("missing debit operation");
	expect(await store.resumeDebitOperation(ctx.db, operation.id)).toBe(true);
	expect((await attemptFor(id)).status).toBe("eligible");
	await notify(id, "success");
	expect(await store.resumeDebitOperation(ctx.db, operation.id)).toBe(false);
	expect((await debit()).sign).not.toHaveBeenCalled();
});
