import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { type Address, type Hex, keccak256 } from "viem";
import type { Db } from "../../db/index.js";
import type { AuditEvent } from "../../domain/audit.js";
import {
	type DebitEscrow,
	nonSettlementDebit,
	revertDebit,
	slippageDebit,
} from "../../domain/penalty.js";
import * as store from "../storage.js";

const MAX_DEBIT_ATTEMPTS = 10;

/**
 * On-chain reason for a non-settlement debit: keccak of the raw order UID
 * bytes, same as the Rust service. No settlement tx exists to cite, so the
 * reason is the order the sub-solver won and abandoned.
 */
export function nonSettlementReason(orderUid: string): Hex {
	return keccak256(orderUid as Hex);
}

export interface PenaltyWorkerConfig {
	db: Db;
	operator: DebitEscrow;
	cL: bigint;
	onAuditEvent: (event: AuditEvent) => void;
	logger: Logger;
}

export function createPenaltyWorker(connection: Redis, config: PenaltyWorkerConfig): Worker {
	const revertAttempts = new Map<number, number>();
	const nonSettlementAttempts = new Map<number, number>();

	const slippageAttempts = new Map<number, number>();

	return new Worker(
		"byos:penalty",
		async () => {
			await runRevertDebits(config, revertAttempts);
			await runNonSettlementDebits(config, nonSettlementAttempts);
			await runSlippageDebits(config, slippageAttempts);
		},
		{
			connection,
			concurrency: 1,
		},
	);
}

/**
 * Count a failed chain call against the per-item cap: warn while retries
 * remain, one error when the item is parked until restart.
 */
function noteDebitFailure(
	attempts: Map<number, number>,
	key: number,
	e: unknown,
	what: string,
	logger: Logger,
): void {
	const count = (attempts.get(key) ?? 0) + 1;
	attempts.set(key, count);
	if (count >= MAX_DEBIT_ATTEMPTS) {
		logger.error(
			{ err: e, id: key, attempts: count },
			`${what} keeps failing; giving up until restart`,
		);
	} else {
		logger.warn({ err: e, id: key, attempts: count }, `${what} failed; retrying next tick`);
	}
}

export async function runRevertDebits(
	config: PenaltyWorkerConfig,
	attempts: Map<number, number>,
): Promise<void> {
	const { db, operator, cL, onAuditEvent, logger } = config;

	let pending: Awaited<ReturnType<typeof store.snapshotByStatuses>>;
	try {
		pending = await store.snapshotByStatuses(db, ["settleFailed"]);
	} catch (e) {
		logger.error({ err: e }, "penalty: failed to snapshot SettleFailed");
		return;
	}

	for (const proposal of pending) {
		if ((attempts.get(proposal.id) ?? 0) >= MAX_DEBIT_ATTEMPTS) continue;

		if (!proposal.settlementTxHash) {
			logger.error({ id: proposal.id }, "settleFailed without settlement tx; cannot debit");
			continue;
		}

		let cost: bigint;
		try {
			cost = await operator.settlementCost(proposal.settlementTxHash);
		} catch (e) {
			noteDebitFailure(attempts, proposal.id, e, "settlement cost lookup", logger);
			continue;
		}

		const amount = revertDebit(cost, cL);
		let penaltyTxHash: Awaited<ReturnType<typeof operator.debit>>;
		try {
			penaltyTxHash = await operator.debit(proposal.subSolver, amount, proposal.settlementTxHash);
		} catch (e) {
			noteDebitFailure(attempts, proposal.id, e, "escrow debit", logger);
			continue;
		}

		// The debit is on-chain: the cap counts chain failures only, so a
		// record failure below must not eat retry budget.
		attempts.delete(proposal.id);

		try {
			const result = await store.recordPenalty(db, proposal, amount, penaltyTxHash);
			if ("auditEvent" in result) {
				onAuditEvent(result.auditEvent);
				logger.info(
					{ id: proposal.id, amount: amount.toString(), tx: penaltyTxHash },
					"revert debit landed",
				);
			} else {
				logger.error(
					{ id: proposal.id, error: result },
					"debit landed but proposal not marked penalized; may re-charge next tick",
				);
			}
		} catch (e) {
			logger.error(
				{ err: e, id: proposal.id },
				"debit landed but proposal not marked penalized; may re-charge next tick",
			);
		}
	}
}

export async function runNonSettlementDebits(
	config: PenaltyWorkerConfig,
	attempts: Map<number, number>,
): Promise<void> {
	const { db, operator, cL, onAuditEvent, logger } = config;

	let pending: Awaited<ReturnType<typeof store.pendingPenalties>>;
	try {
		pending = await store.pendingPenalties(db);
	} catch (e) {
		logger.error({ err: e }, "penalty: failed to fetch pending penalties");
		return;
	}

	for (const penalty of pending) {
		if ((attempts.get(penalty.id) ?? 0) >= MAX_DEBIT_ATTEMPTS) continue;

		const amount = nonSettlementDebit(cL);
		const reason = nonSettlementReason(penalty.orderUid);
		let penaltyTxHash: Awaited<ReturnType<typeof operator.debit>>;
		try {
			penaltyTxHash = await operator.debit(penalty.subSolver, amount, reason);
		} catch (e) {
			noteDebitFailure(attempts, penalty.id, e, "non-settlement debit", logger);
			continue;
		}

		attempts.delete(penalty.id);

		try {
			const auditEvent = await store.recordNonSettlementDebit(db, penalty, amount, penaltyTxHash);
			onAuditEvent(auditEvent);
			logger.info(
				{ penaltyId: penalty.id, amount: amount.toString(), tx: penaltyTxHash },
				"non-settlement debit landed",
			);
		} catch (e) {
			logger.error(
				{ err: e, penaltyId: penalty.id },
				"non-settlement debit landed but was not recorded; may re-charge next tick",
			);
		}
	}
}

export async function runSlippageDebits(
	config: PenaltyWorkerConfig,
	attempts: Map<number, number>,
): Promise<void> {
	const { db, operator, cL, onAuditEvent, logger } = config;

	// Step 1: Snapshot settled proposals with loose slippage that have
	// no ledger entry yet.
	let pending: Awaited<ReturnType<typeof store.snapshotByStatuses>>;
	try {
		pending = await store.snapshotByStatuses(db, ["settled"]);
	} catch (e) {
		logger.error({ err: e }, "slippage: failed to snapshot settled proposals");
		return;
	}

	const slippagePending = pending.filter((p) => p.minBuyAmount < p.quoteBuyAmount);
	const affectedSubSolvers = new Set<Address>();

	// Step 2: For each proposal without a ledger entry, compute and insert one.
	for (const proposal of slippagePending) {
		if ((attempts.get(proposal.id) ?? 0) >= MAX_DEBIT_ATTEMPTS) continue;

		// Skip proposals that already have a ledger entry
		try {
			if (await store.slippageEntryExistsForProposal(db, proposal.id)) continue;
		} catch (e) {
			noteDebitFailure(attempts, proposal.id, e, "slippage entry existence check", logger);
			continue;
		}

		if (!proposal.settlementTxHash) {
			logger.error({ id: proposal.id }, "settled without settlement tx; cannot compute slippage");
			continue;
		}

		let delta: bigint;
		try {
			delta = await operator.readExecutedDelta(proposal.settlementTxHash, proposal.orderUidHash);
		} catch (e) {
			noteDebitFailure(attempts, proposal.id, e, "readExecutedDelta", logger);
			continue;
		}

		let refPriceStr: string | null;
		try {
			refPriceStr = await store.buyTokenRefPriceForProposal(db, proposal.id);
		} catch (e) {
			noteDebitFailure(attempts, proposal.id, e, "buyTokenRefPrice lookup", logger);
			continue;
		}

		if (!refPriceStr || refPriceStr === "0") {
			logger.warn({ id: proposal.id }, "no buy-token ref price for slippage; skipping");
			attempts.delete(proposal.id);
			continue;
		}

		const gap = proposal.quoteBuyAmount - delta;
		const refPrice = BigInt(refPriceStr);
		const ethAmount = slippageDebit(gap < 0n ? -gap : gap, refPrice);
		// Preserve sign: positive = subsolver owes, negative = BYOS owes
		const signedEthAmount = gap < 0n ? -ethAmount : ethAmount;

		try {
			await store.insertSlippageEntry(db, {
				subSolver: proposal.subSolver,
				proposalId: proposal.id,
				orderUid: proposal.orderUid,
				delta: delta.toString(),
				gap: gap.toString(),
				ethAmount: signedEthAmount.toString(),
			});
			affectedSubSolvers.add(proposal.subSolver);
			attempts.delete(proposal.id);
			logger.info(
				{ id: proposal.id, gap: gap.toString(), ethAmount: signedEthAmount.toString() },
				"slippage entry recorded",
			);
		} catch (e) {
			noteDebitFailure(attempts, proposal.id, e, "slippage entry insert", logger);
		}
	}

	// Also check subsolvers with pre-existing uncleared entries (from previous ticks
	// where balance was below threshold, or where a prior debit failed and entries
	// were reverted).
	try {
		const existing = await store.unclearedSlippageSubSolvers(db);
		for (const s of existing) affectedSubSolvers.add(s);
	} catch (e) {
		logger.error({ err: e }, "slippage: failed to fetch subsolvers with uncleared entries");
	}

	// Step 3: For each affected subsolver, check if outstanding balance exceeds c_L.
	// Uses a mark-before-debit pattern to prevent double-charging:
	//   a) Mark entries in-flight (cleared=true, clear_tx_hash=NULL)
	//   b) Call operator.debit()
	//   c) Finalize with real tx hash — or revert if the debit fails
	// In-flight entries are excluded from balance queries, so a crash between
	// (a) and (b) results in under-charging (safe), never double-charging.
	for (const subSolver of affectedSubSolvers) {
		let balance: bigint;
		try {
			balance = await store.outstandingSlippageBalance(db, subSolver);
		} catch (e) {
			logger.error({ err: e, subSolver }, "slippage: failed to read outstanding balance");
			continue;
		}

		if (balance <= cL) continue;

		// (a) Mark entries in-flight before the on-chain call
		let entryCount: number;
		try {
			entryCount = await store.markSlippageEntriesInFlight(db, subSolver);
		} catch (e) {
			logger.error({ err: e, subSolver }, "slippage: failed to mark entries in-flight");
			continue;
		}

		// (b) Debit escrow
		let clearTxHash: Hex;
		try {
			clearTxHash = await operator.debit(
				subSolver,
				balance,
				keccak256(`0x${subSolver.slice(2)}${"00".repeat(12)}` as Hex),
			);
		} catch (e) {
			logger.error(
				{ err: e, subSolver, balance: balance.toString() },
				"slippage escrow debit failed; reverting in-flight entries",
			);
			try {
				await store.revertInFlightSlippageEntries(db, subSolver);
			} catch (revertErr) {
				logger.error(
					{ err: revertErr, subSolver },
					"failed to revert in-flight entries after debit failure",
				);
			}
			continue;
		}

		// (c) Finalize with the real tx hash
		try {
			await store.finalizeSlippageEntries(db, subSolver, clearTxHash);
		} catch (e) {
			// The debit landed but finalize failed. Entries remain in-flight
			// (cleared=true, clear_tx_hash=NULL) — they will NOT be re-debited
			// because they are already marked cleared. A manual reconciliation
			// is needed to set the tx hash.
			logger.error(
				{ err: e, subSolver, tx: clearTxHash },
				"slippage debit landed but finalize failed; entries are in-flight, no double-charge risk",
			);
			continue;
		}

		onAuditEvent({
			occurredAt: new Date(),
			kind: {
				type: "slippageDebited",
				subSolver,
				amount: balance,
				clearTxHash,
				entryCount,
			},
		});

		logger.info(
			{ subSolver, balance: balance.toString(), entryCount, tx: clearTxHash },
			"slippage balance slashed",
		);
	}
}
