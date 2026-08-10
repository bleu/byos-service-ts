import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { type Hex, keccak256 } from "viem";
import type { Db } from "../../db/index.js";
import type { AuditEvent } from "../../domain/audit.js";
import { nonSettlementDebit, revertDebit } from "../../domain/penalty.js";
import type { EscrowOperator } from "../blockchain/operator.js";
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
	operator: EscrowOperator;
	cL: bigint;
	onAuditEvent: (event: AuditEvent) => void;
	logger: Logger;
}

export function createPenaltyWorker(connection: Redis, config: PenaltyWorkerConfig): Worker {
	const revertAttempts = new Map<number, number>();
	const nonSettlementAttempts = new Map<number, number>();

	return new Worker(
		"byos:penalty",
		async () => {
			await runRevertDebits(config, revertAttempts);
			await runNonSettlementDebits(config, nonSettlementAttempts);
		},
		{
			connection,
			concurrency: 1,
		},
	);
}

async function runRevertDebits(
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
		const count = attempts.get(proposal.id) ?? 0;
		if (count >= MAX_DEBIT_ATTEMPTS) continue;

		if (!proposal.settlementTxHash) {
			logger.error({ id: proposal.id }, "settleFailed without settlement tx; cannot debit");
			continue;
		}

		try {
			const cost = await operator.settlementCost(proposal.settlementTxHash);
			const amount = revertDebit(cost, cL);
			const penaltyTxHash = await operator.debit(
				proposal.subSolver,
				amount,
				proposal.settlementTxHash,
			);

			const result = await store.recordPenalty(db, proposal, amount, penaltyTxHash);
			if ("auditEvent" in result) {
				onAuditEvent(result.auditEvent);
				attempts.delete(proposal.id);
				logger.info(
					{ id: proposal.id, amount: amount.toString(), tx: penaltyTxHash },
					"revert debit landed",
				);
			}
		} catch (e) {
			const newCount = count + 1;
			attempts.set(proposal.id, newCount);
			if (newCount >= MAX_DEBIT_ATTEMPTS) {
				logger.error({ err: e, id: proposal.id, attempts: newCount }, "revert debit parked");
			} else {
				logger.warn({ err: e, id: proposal.id, attempts: newCount }, "revert debit failed");
			}
		}
	}
}

async function runNonSettlementDebits(
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
		const count = attempts.get(penalty.id) ?? 0;
		if (count >= MAX_DEBIT_ATTEMPTS) continue;

		try {
			const amount = nonSettlementDebit(cL);
			const reason = nonSettlementReason(penalty.orderUid);
			const penaltyTxHash = await operator.debit(penalty.subSolver, amount, reason);

			const auditEvent = await store.recordNonSettlementDebit(db, penalty, amount, penaltyTxHash);
			onAuditEvent(auditEvent);
			attempts.delete(penalty.id);
			logger.info(
				{ penaltyId: penalty.id, amount: amount.toString(), tx: penaltyTxHash },
				"non-settlement debit landed",
			);
		} catch (e) {
			const newCount = count + 1;
			attempts.set(penalty.id, newCount);
			if (newCount >= MAX_DEBIT_ATTEMPTS) {
				logger.error(
					{ err: e, penaltyId: penalty.id, attempts: newCount },
					"non-settlement debit parked",
				);
			} else {
				logger.warn(
					{ err: e, penaltyId: penalty.id, attempts: newCount },
					"non-settlement debit failed",
				);
			}
		}
	}
}
