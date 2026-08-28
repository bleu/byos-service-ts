import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { type Address, type Hex, keccak256 } from "viem";
import type { Db } from "../../db/index.js";
import type { AuditEvent } from "../../domain/audit.js";
import {
	bufferDebit,
	type DebitEscrow,
	nonSettlementDebit,
	revertDebit,
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
	/** Unique process-instance identity used only for expiring database leases. */
	workerId: string;
}

export function createPenaltyWorker(connection: Redis, config: PenaltyWorkerConfig): Worker {
	return new Worker(
		"penalty",
		async () => {
			await runRevertDebits(config, new Map());
			await runNonSettlementDebits(config, new Map());
			await runBufferDebits(config, new Map());
		},
		{
			connection,
			prefix: "byos",
			concurrency: 1,
		},
	);
}

const LEASE_SECS = 60;
interface LandedDebit {
	hash: Hex;
	operationId: number;
	owner: string;
}

interface BufferBatch {
	subSolver: Address;
	entryIds: number[];
}

/** The source key is the durable link between one buffer debit and its exact ledger rows. */
function bufferBatchFromSourceId(sourceId: string): BufferBatch | null {
	const match = /^subsolver:(0x[0-9a-f]{40}):entries:([1-9][0-9]*(?:,[1-9][0-9]*)*)$/.exec(
		sourceId,
	);
	const subSolver = match?.[1];
	const encodedEntryIds = match?.[2];
	if (!subSolver || !encodedEntryIds) return null;
	const entryIds = encodedEntryIds.split(",").map(Number);
	if (entryIds.some((id) => !Number.isSafeInteger(id))) return null;
	return { subSolver: subSolver as Address, entryIds };
}

/**
 * Performs one operation under its Postgres lease. The stored raw transaction
 * is deliberately the sole broadcast input after the first signature.
 */
async function durableDebit(
	config: PenaltyWorkerConfig,
	sourceKind: string,
	sourceId: string,
	subSolver: Address,
	amount: bigint,
	reason: Hex,
): Promise<LandedDebit | null> {
	const { db, operator, logger } = config;
	const operation = await store.createDebitOperation(db, {
		sourceKind,
		sourceId,
		subSolver,
		amount,
		reason,
	});
	const owner = config.workerId;
	const claimed = await store.claimDebitOperation(db, operation.id, owner, LEASE_SECS);
	if (!claimed) return null;

	// Kept solely for existing lightweight test doubles. EscrowOperator always
	// exposes the durable interface, which is required in every real process.
	if (!operator.signDebit || !operator.broadcastSignedDebit || !operator.debitOutcome) {
		try {
			if (!operator.debit) throw new Error("operator does not support durable debit operations");
			const hash = await operator.debit(subSolver, amount, reason);
			return { hash, operationId: claimed.id, owner };
		} catch (e) {
			await store.recordDebitFailure(
				db,
				claimed.id,
				owner,
				e instanceof Error ? e.message : String(e),
			);
			return null;
		}
	}

	let rawTransaction = claimed.rawTransaction;
	let transactionHash = claimed.transactionHash;
	try {
		if (!rawTransaction || !transactionHash) {
			const signed = await operator.signDebit(subSolver, claimed.amount, claimed.reason);
			if (
				!(await store.persistSignedDebit(db, claimed.id, owner, signed.rawTransaction, signed.hash))
			) {
				return null;
			}
			rawTransaction = signed.rawTransaction;
			transactionHash = signed.hash;
		}

		const outcome = await operator.debitOutcome(transactionHash);
		if (outcome === "succeeded") {
			return { hash: transactionHash, operationId: claimed.id, owner };
		}
		if (outcome === "reverted") throw new Error(`debit tx ${transactionHash} reverted`);

		const broadcastHash = await operator.broadcastSignedDebit(rawTransaction);
		if (broadcastHash.toLowerCase() !== transactionHash.toLowerCase()) {
			throw new Error(`broadcast returned unexpected debit hash ${broadcastHash}`);
		}
		const broadcastOutcome = await operator.debitOutcome(transactionHash);
		if (broadcastOutcome === "succeeded") {
			return { hash: transactionHash, operationId: claimed.id, owner };
		}
		if (broadcastOutcome === "reverted") throw new Error(`debit tx ${transactionHash} reverted`);
		throw new Error(`debit tx ${transactionHash} outcome is not yet known`);
	} catch (e) {
		await store.recordDebitFailure(
			db,
			claimed.id,
			owner,
			e instanceof Error ? e.message : String(e),
		);
		logger.warn({ err: e, operationId: claimed.id }, "durable debit deferred");
		return null;
	}
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
		const landedDebit = await durableDebit(
			config,
			"revert",
			`proposal:${proposal.id}`,
			proposal.subSolver,
			amount,
			proposal.settlementTxHash,
		);
		if (!landedDebit) continue;
		const penaltyTxHash = landedDebit.hash;

		// The debit is on-chain: the cap counts chain failures only, so a
		// record failure below must not eat retry budget.
		attempts.delete(proposal.id);

		try {
			const result = await store.recordPenalty(db, proposal, amount, penaltyTxHash);
			if ("auditEvent" in result) {
				await store.completeDebitOperation(db, landedDebit.operationId, landedDebit.owner);
				onAuditEvent(result.auditEvent);
				logger.info(
					{ id: proposal.id, amount: amount.toString(), tx: penaltyTxHash },
					"revert debit landed",
				);
			} else {
				await store.completeDebitOperation(db, landedDebit.operationId, landedDebit.owner);
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
	const { db, cL, onAuditEvent, logger } = config;

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
		const landedDebit = await durableDebit(
			config,
			"non-settlement",
			`penalty:${penalty.id}`,
			penalty.subSolver,
			amount,
			reason,
		);
		if (!landedDebit) continue;
		const penaltyTxHash = landedDebit.hash;

		attempts.delete(penalty.id);

		try {
			const auditEvent = await store.recordNonSettlementDebit(db, penalty, amount, penaltyTxHash);
			await store.completeDebitOperation(db, landedDebit.operationId, landedDebit.owner);
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

/**
 * Processes buffer accounting for settled proposals with aggressive slippage
 * (minBuyAmount < quoteBuyAmount).
 *
 * Step 1: Record a ledger entry per proposal (signed: positive = under-delivery,
 *         negative = over-delivery credit).
 * Step 2: For each subsolver with uncleared entries, check if the outstanding
 *         balance exceeds c_L. If so, slash the full balance from escrow and
 *         mark all entries cleared.
 *
 * Over-delivery credits offset future shortfalls but are never paid out.
 *
 * Debits use a mark-before-debit pattern to prevent double-charging on DB
 * failures after a successful on-chain debit.
 */
export async function runBufferDebits(
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
		logger.error({ err: e }, "buffer: failed to snapshot settled proposals");
		return;
	}

	const bufferPending = pending.filter((p) => p.minBuyAmount < p.quoteBuyAmount);
	const affectedSubSolvers = new Set<Address>();

	// Step 2: For each proposal without a ledger entry, compute and insert one.
	for (const proposal of bufferPending) {
		if ((attempts.get(proposal.id) ?? 0) >= MAX_DEBIT_ATTEMPTS) continue;

		// Skip proposals that already have a ledger entry
		try {
			if (await store.bufferEntryExistsForProposal(db, proposal.id)) continue;
		} catch (e) {
			noteDebitFailure(attempts, proposal.id, e, "buffer entry existence check", logger);
			continue;
		}

		if (!proposal.settlementTxHash) {
			logger.error({ id: proposal.id }, "settled without settlement tx; cannot compute buffer");
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
			logger.warn({ id: proposal.id }, "no buy-token ref price for buffer; skipping");
			attempts.delete(proposal.id);
			continue;
		}

		const gap = proposal.quoteBuyAmount - delta;
		const refPrice = BigInt(refPriceStr);
		const nativeAmount = bufferDebit(gap < 0n ? -gap : gap, refPrice);
		// Preserve sign: positive = under-delivery debit, negative = over-delivery credit
		const signedNativeAmount = gap < 0n ? -nativeAmount : nativeAmount;

		try {
			await store.insertBufferEntry(db, {
				subSolver: proposal.subSolver,
				proposalId: proposal.id,
				orderUid: proposal.orderUid,
				buyToken: proposal.buyToken,
				delta: delta.toString(),
				gap: gap.toString(),
				nativeTokenAmount: signedNativeAmount.toString(),
			});
			affectedSubSolvers.add(proposal.subSolver);
			attempts.delete(proposal.id);
			logger.info(
				{ id: proposal.id, gap: gap.toString(), nativeTokenAmount: signedNativeAmount.toString() },
				"buffer entry recorded",
			);
		} catch (e) {
			noteDebitFailure(attempts, proposal.id, e, "buffer entry insert", logger);
		}
	}

	// Also check subsolvers with pre-existing uncleared entries (from previous ticks
	// where balance was below threshold, or where a prior debit failed and entries
	// were reverted).
	try {
		const existing = await store.unclearedBufferSubSolvers(db);
		for (const s of existing) affectedSubSolvers.add(s);
	} catch (e) {
		logger.error({ err: e }, "buffer: failed to fetch subsolvers with uncleared entries");
	}

	// Step 3: For each affected subsolver, check if outstanding balance exceeds c_L.
	// Resume a buffer batch that was marked in-flight by a worker which then
	// disappeared. Its source id names the exact entry set and its transaction
	// (if any) is already durable, so this never creates a replacement debit.
	for (const operation of await store.openDebitOperations(db, "buffer")) {
		const batch = bufferBatchFromSourceId(operation.sourceId);
		if (!batch) {
			logger.error({ operationId: operation.id }, "buffer: invalid durable operation source key");
			continue;
		}
		try {
			// A crash may have happened after creating the operation but before
			// marking its rows. Recovery always repairs that gap before a debit.
			await store.markBufferEntriesInFlight(db, batch.subSolver, batch.entryIds);
		} catch (e) {
			logger.error(
				{ err: e, operationId: operation.id },
				"buffer: failed to recover in-flight entries",
			);
			continue;
		}
		const landedDebit = await durableDebit(
			config,
			operation.sourceKind,
			operation.sourceId,
			operation.subSolver,
			operation.amount,
			operation.reason,
		);
		if (landedDebit) {
			await store.finalizeBufferEntries(db, batch.subSolver, batch.entryIds, landedDebit.hash);
			await store.completeDebitOperation(db, landedDebit.operationId, landedDebit.owner);
		}
	}

	for (const subSolver of affectedSubSolvers) {
		let balance: bigint;
		try {
			balance = await store.outstandingBufferBalance(db, subSolver);
		} catch (e) {
			logger.error({ err: e, subSolver }, "buffer: failed to read outstanding balance");
			continue;
		}

		if (balance <= cL) continue;

		const entries = await store.unclearedBufferEntries(db, subSolver);
		const entryIds = entries.map((entry) => entry.id);
		const sourceId = `subsolver:${subSolver.toLowerCase()}:entries:${entryIds.join(",")}`;
		const reason = keccak256(`0x${subSolver.slice(2)}${"00".repeat(12)}` as Hex);

		// Create the event before marking its entries. A crash at any later
		// point is recoverable through openDebitOperations above.
		await store.createDebitOperation(db, {
			sourceKind: "buffer",
			sourceId,
			subSolver,
			amount: balance,
			reason,
		});

		// (a) Mark this precise batch in-flight before the chain call.
		let entryCount: number;
		try {
			entryCount = await store.markBufferEntriesInFlight(db, subSolver, entryIds);
		} catch (e) {
			logger.error({ err: e, subSolver }, "buffer: failed to mark entries in-flight");
			continue;
		}

		// (b) Sign/persist/broadcast exactly once. Failed attempts stay in-flight
		// until the durable operation is retried or explicitly reconciled.
		const landedDebit = await durableDebit(config, "buffer", sourceId, subSolver, balance, reason);
		if (!landedDebit) continue;
		const clearTxHash = landedDebit.hash;

		// (c) Finalize with the real tx hash
		try {
			await store.finalizeBufferEntries(db, subSolver, entryIds, clearTxHash);
			await store.completeDebitOperation(db, landedDebit.operationId, landedDebit.owner);
		} catch (e) {
			// The debit landed but finalize failed. Entries remain in-flight
			// (cleared=true, clear_tx_hash=NULL) — they will NOT be re-debited
			// because they are already marked cleared. A manual reconciliation
			// is needed to set the tx hash.
			logger.error(
				{ err: e, subSolver, tx: clearTxHash },
				"buffer debit landed but finalize failed; entries are in-flight, no double-charge risk",
			);
			continue;
		}

		onAuditEvent({
			occurredAt: new Date(),
			kind: {
				type: "bufferDebited",
				subSolver,
				amount: balance,
				clearTxHash,
				entryCount,
			},
		});

		logger.info(
			{ subSolver, balance: balance.toString(), entryCount, tx: clearTxHash },
			"buffer balance slashed",
		);
	}
}
