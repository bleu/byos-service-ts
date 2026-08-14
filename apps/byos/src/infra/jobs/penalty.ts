import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { type Hex, keccak256 } from "viem";
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
	const { db, operator, onAuditEvent, logger } = config;

	// Snapshot settled proposals where minBuyAmount < maxBuyAmount
	let pending: Awaited<ReturnType<typeof store.snapshotByStatuses>>;
	try {
		pending = await store.snapshotByStatuses(db, ["settled"]);
	} catch (e) {
		logger.error({ err: e }, "penalty: failed to snapshot settled for slippage");
		return;
	}

	// Filter to proposals with aggressive slippage (minBuyAmount < maxBuyAmount)
	const slippagePending = pending.filter((p) => p.minBuyAmount < p.maxBuyAmount);
	if (slippagePending.length === 0) return;

	for (const proposal of slippagePending) {
		if ((attempts.get(proposal.id) ?? 0) >= MAX_DEBIT_ATTEMPTS) continue;

		if (!proposal.settlementTxHash) {
			logger.error({ id: proposal.id }, "settled without settlement tx; cannot compute slippage");
			continue;
		}

		// Read the delivered delta from the Executed event
		let delta: bigint;
		try {
			delta = await operator.readExecutedDelta(proposal.settlementTxHash);
		} catch (e) {
			noteDebitFailure(attempts, proposal.id, e, "readExecutedDelta", logger);
			continue;
		}

		const gap = proposal.maxBuyAmount - delta;
		if (gap <= 0n) {
			// Over-delivered or exact: no debit needed. Mark as processed by
			// transitioning to penalized with zero-cost penalty.
			attempts.delete(proposal.id);
			continue;
		}

		// Look up the buy-token reference price stored at /solve time
		let refPriceStr: string | null;
		try {
			refPriceStr = await store.buyTokenRefPriceForProposal(db, proposal.id);
		} catch (e) {
			noteDebitFailure(attempts, proposal.id, e, "buyTokenRefPrice lookup", logger);
			continue;
		}

		if (!refPriceStr || refPriceStr === "0") {
			logger.warn({ id: proposal.id }, "no buy-token ref price for slippage debit; skipping");
			attempts.delete(proposal.id);
			continue;
		}

		const refPrice = BigInt(refPriceStr);
		const amount = slippageDebit(gap, refPrice);
		if (amount === 0n) {
			attempts.delete(proposal.id);
			continue;
		}

		let penaltyTxHash: Awaited<ReturnType<typeof operator.debit>>;
		try {
			penaltyTxHash = await operator.debit(proposal.subSolver, amount, proposal.settlementTxHash);
		} catch (e) {
			noteDebitFailure(attempts, proposal.id, e, "slippage escrow debit", logger);
			continue;
		}

		attempts.delete(proposal.id);

		try {
			const result = await store.recordPenalty(db, proposal, amount, penaltyTxHash);
			if ("auditEvent" in result) {
				onAuditEvent(result.auditEvent);
				logger.info(
					{ id: proposal.id, gap: gap.toString(), amount: amount.toString(), tx: penaltyTxHash },
					"slippage debit landed",
				);
			} else {
				logger.error(
					{ id: proposal.id, error: result },
					"slippage debit landed but proposal not marked penalized; may re-charge next tick",
				);
			}
		} catch (e) {
			logger.error(
				{ err: e, id: proposal.id },
				"slippage debit landed but proposal not marked penalized; may re-charge next tick",
			);
		}
	}
}
