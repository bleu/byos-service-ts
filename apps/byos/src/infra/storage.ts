import type { RejectionReason, Status } from "@byos/common";
import { and, desc, eq, inArray, notExists, or, sql } from "drizzle-orm";
import type { Address, Hex } from "viem";
import type { Db } from "../db/index.js";
import {
	bufferEntries,
	debitOperations,
	proposals,
	proposalsLog,
	serviceState,
	settlementAttemptMembers,
	settlementAttempts,
} from "../db/schema.js";
import type { AuditEvent } from "../domain/audit.js";
import { nativeSellValue } from "../domain/collateral.js";
import type { Proposal, SettlementOutcome } from "../domain/proposal.js";
import type { Candidate } from "./candidate-store.js";
import {
	eligibleNonSettlementPenalties,
	RETRY_RECONCILIATION_REASON,
} from "./settlement-attempts.js";

// --- Store Error ---

export type StoreError =
	| { kind: "notFound"; id: number }
	| { kind: "notOwner"; id: number; owner: Address }
	// `actual` is the status the row was found in. A compare-and-swap that
	// affected no rows never learns it, so it is null there rather than a
	// stand-in string a reader could mistake for a real status.
	| { kind: "staleTransition"; id: number; expected: string; actual: string | null }
	| { kind: "database"; cause: unknown }
	| { kind: "corruptRow"; table: string; column: string; detail: string };

export function shouldRetry(error: StoreError): boolean {
	return error.kind === "database";
}

// --- Shared replica state ---

/** Publishes the valid auction price that validators use on every replica. */
export async function publishAuctionGasPrice(db: Db, gasPrice: bigint): Promise<void> {
	await db
		.insert(serviceState)
		.values({
			id: 1,
			latestAuctionGasPrice: gasPrice.toString(),
			latestAuctionGasPriceAt: sql`now()`,
		})
		.onConflictDoUpdate({
			target: serviceState.id,
			set: {
				latestAuctionGasPrice: gasPrice.toString(),
				latestAuctionGasPriceAt: sql`now()`,
			},
		});
}

/** Reads the fleet-wide auction price, retaining the configured fallback before any auction arrives. */
export async function latestAuctionGasPrice(db: Db, fallback: bigint): Promise<bigint> {
	const [state] = await db
		.select({ gasPrice: serviceState.latestAuctionGasPrice })
		.from(serviceState)
		.where(eq(serviceState.id, 1));

	return state?.gasPrice === null || state?.gasPrice === undefined
		? fallback
		: BigInt(state.gasPrice);
}

export interface DebitOperation {
	id: number;
	sourceKind: string;
	sourceId: string;
	subSolver: Address;
	amount: bigint;
	reason: Hex;
	status: string;
	rawTransaction: Hex | null;
	transactionHash: Hex | null;
}

export type DebitOperationInput = Pick<
	DebitOperation,
	"sourceKind" | "sourceId" | "subSolver" | "amount" | "reason"
>;

function rowToDebitOperation(row: typeof debitOperations.$inferSelect): DebitOperation {
	return {
		id: row.id,
		sourceKind: row.sourceKind,
		sourceId: row.sourceId,
		subSolver: row.subSolver as Address,
		amount: BigInt(row.amount),
		reason: row.reason as Hex,
		status: row.status,
		rawTransaction: (row.rawTransaction as Hex) ?? null,
		transactionHash: (row.transactionHash as Hex) ?? null,
	};
}

/** Stores the only transaction bytes this operation may ever broadcast. */
export async function persistSignedDebit(
	db: Db,
	id: number,
	owner: string,
	rawTransaction: Hex,
	transactionHash: Hex,
): Promise<boolean> {
	const [row] = await db
		.update(debitOperations)
		.set({
			rawTransaction: rawTransaction.toLowerCase(),
			transactionHash: transactionHash.toLowerCase(),
			status: "broadcasting",
			updatedAt: sql`now()`,
		})
		.where(
			and(
				eq(debitOperations.id, id),
				eq(debitOperations.leaseOwner, owner),
				sql`${debitOperations.rawTransaction} IS NULL`,
			),
		)
		.returning({ id: debitOperations.id });
	return row !== undefined;
}

export async function completeDebitOperation(db: Db, id: number, owner: string): Promise<boolean> {
	const [row] = await db
		.update(debitOperations)
		.set({
			status: "completed",
			leaseOwner: null,
			leaseExpiresAt: null,
			nextRetryAt: null,
			updatedAt: sql`now()`,
		})
		.where(and(eq(debitOperations.id, id), eq(debitOperations.leaseOwner, owner)))
		.returning({ id: debitOperations.id });
	return row !== undefined;
}

/** Creates exactly one durable operation for a chargeable event. */
export async function createDebitOperation(
	db: Db,
	operation: DebitOperationInput,
): Promise<DebitOperation> {
	await db
		.insert(debitOperations)
		.values({
			sourceKind: operation.sourceKind,
			sourceId: operation.sourceId,
			subSolver: operation.subSolver.toLowerCase(),
			amount: operation.amount.toString(),
			reason: operation.reason.toLowerCase(),
		})
		.onConflictDoNothing();
	const [row] = await db
		.select()
		.from(debitOperations)
		.where(
			and(
				eq(debitOperations.sourceKind, operation.sourceKind),
				eq(debitOperations.sourceId, operation.sourceId),
			),
		);
	if (!row) throw new Error("debit operation disappeared after creation");
	return rowToDebitOperation(row);
}

/** Atomically grants an unowned or expired lease to one replica. */
export async function claimDebitOperation(
	db: Db,
	id: number,
	owner: string,
	leaseSecs: number,
): Promise<DebitOperation | null> {
	const [row] = await db
		.update(debitOperations)
		.set({
			leaseOwner: owner,
			leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSecs})`,
			updatedAt: sql`now()`,
		})
		.where(
			and(
				eq(debitOperations.id, id),
				inArray(debitOperations.status, ["pending", "broadcasting"]),
				or(
					sql`${debitOperations.leaseExpiresAt} IS NULL`,
					sql`${debitOperations.leaseExpiresAt} < now()`,
				),
			),
		)
		.returning();
	return row ? rowToDebitOperation(row) : null;
}

/** Records a recoverable broadcast/lookup failure against the operation lease. */
export async function recordDebitFailure(
	db: Db,
	id: number,
	owner: string,
	error: string,
): Promise<void> {
	await db
		.update(debitOperations)
		.set({
			attemptCount: sql`${debitOperations.attemptCount} + 1`,
			lastError: error,
			status: sql`CASE WHEN ${debitOperations.attemptCount} + 1 >= 10 THEN 'needs_reconciliation' ELSE 'pending' END`,
			nextRetryAt: sql`CASE WHEN ${debitOperations.attemptCount} + 1 >= 10 THEN NULL ELSE now() END`,
			leaseOwner: null,
			leaseExpiresAt: null,
			updatedAt: sql`now()`,
		})
		.where(and(eq(debitOperations.id, id), eq(debitOperations.leaseOwner, owner)))
		.returning({ attemptCount: debitOperations.attemptCount });
}

export async function debitOperationStatus(db: Db, id: number): Promise<string | null> {
	const [operation] = await db
		.select({ status: debitOperations.status })
		.from(debitOperations)
		.where(eq(debitOperations.id, id));
	return operation?.status ?? null;
}

/** Returns a reconciliation-paused operation to the durable retry loop. */
export async function resumeDebitOperation(db: Db, id: number): Promise<boolean> {
	return db.transaction(async (tx) => {
		const [operation] = await tx.select().from(debitOperations).where(eq(debitOperations.id, id));
		if (operation?.status !== "needs_reconciliation") return false;
		let attemptId: number | null = null;
		if (operation.sourceKind === "non-settlement") {
			const match = /^attempt:([1-9]\d*)$/.exec(operation.sourceId);
			if (!match?.[1]) return false; // Legacy charges require evidence review.
			attemptId = Number(match[1]);
			if (!Number.isSafeInteger(attemptId)) return false;
			const [attempt] = await tx
				.select()
				.from(settlementAttempts)
				.where(eq(settlementAttempts.id, attemptId))
				.for("update");
			if (
				attempt?.status !== "needs_reconciliation" ||
				attempt.reconciliationReason !== RETRY_RECONCILIATION_REASON ||
				attempt.outcome !== null ||
				!attempt.startedAt ||
				!attempt.abandonedAt ||
				attempt.amount !== operation.amount ||
				attempt.subSolver !== operation.subSolver
			)
				return false;
		}
		const resumed = await tx
			.update(debitOperations)
			.set({
				status: "pending",
				attemptCount: 0,
				lastError: null,
				nextRetryAt: sql`now()`,
				leaseOwner: null,
				leaseExpiresAt: null,
				updatedAt: sql`now()`,
			})
			.where(and(eq(debitOperations.id, id), eq(debitOperations.status, "needs_reconciliation")))
			.returning({ id: debitOperations.id });
		if (!resumed.length) return false;
		if (attemptId !== null)
			await tx
				.update(settlementAttempts)
				.set({ status: "eligible", reconciliationReason: null })
				.where(eq(settlementAttempts.id, attemptId));
		return true;
	});
}

/** Operations needing automatic recovery; reconciliation-paused rows stay untouched. */
export async function openDebitOperations(db: Db, sourceKind: string): Promise<DebitOperation[]> {
	const rows = await db
		.select()
		.from(debitOperations)
		.where(
			and(
				eq(debitOperations.sourceKind, sourceKind),
				inArray(debitOperations.status, ["pending", "broadcasting"]),
			),
		);
	return rows.map(rowToDebitOperation);
}

// --- Row Codec ---

type ProposalRow = typeof proposals.$inferSelect | typeof proposalsLog.$inferSelect;

function rowToProposal(row: ProposalRow): Proposal {
	const interactions = (
		row.interactions as Array<{ target: string; value: string; callData: string }>
	).map((i) => ({
		target: i.target as Address,
		value: BigInt(i.value),
		callData: i.callData as Hex,
	}));

	return {
		id: row.id,
		subSolver: row.subSolver as Address,
		orderUid: row.orderUid,
		orderUidHash: row.orderUidHash as Hex,
		sellAmount: BigInt(row.sellAmount),
		minBuyAmount: BigInt(row.minBuyAmount),
		quoteBuyAmount: BigInt(row.quoteBuyAmount),
		sellToken: row.sellToken as Address,
		buyToken: row.buyToken as Address,
		interactions,
		interactionsHash: row.interactionsHash as Hex,
		validUntil: BigInt(row.validUntil),
		nonce: BigInt(row.nonce),
		signature: row.signature as Hex,
		status: row.status as Status,
		rejectionReason: (row.rejectionReason as RejectionReason) ?? null,
		gasUsed: row.gasUsed != null ? BigInt(row.gasUsed) : null,
		trampoline: (row.trampoline as Address) ?? null,
		settlementTxHash: (row.settlementTxHash as Hex) ?? null,
		penaltyTxHash: (row.penaltyTxHash as Hex) ?? null,
		simulationFailureParams: row.simulationFailureParams ?? null,
		createdAt: row.createdAt,
		statusChangedAt: row.statusChangedAt,
		sellTokenRefPrice: row.sellTokenRefPrice ?? null,
		buyTokenRefPrice: row.buyTokenRefPrice ?? null,
		settlementPenaltyCap:
			row.settlementPenaltyCap == null ? null : BigInt(row.settlementPenaltyCap),
		surplusTokenRefPrice: row.surplusTokenRefPrice ?? null,
		auctionGasPrice: row.auctionGasPrice ?? null,
		clearingPrices: (row.clearingPrices as Record<string, string>) ?? null,
		simulationBuyAmount: row.simulationBuyAmount != null ? BigInt(row.simulationBuyAmount) : null,
		auctionId: row.auctionId ?? null,
	};
}

function tryRowToProposal(row: ProposalRow): Proposal | null {
	try {
		return rowToProposal(row);
	} catch {
		return null;
	}
}

/**
 * Whether the `id` column can hold this value.
 *
 * Ids reach the store from the sequence, always in range, and from the URL
 * path, which is whatever `Number()` made of it. Sending a fraction or a value
 * past the column's range to Postgres raises a driver error, and the handler
 * turns that into a 500 for what is really a miss.
 */
function isStorableId(id: number): boolean {
	return Number.isSafeInteger(id) && id >= 0;
}

function interactionsToJson(interactions: Proposal["interactions"]) {
	return interactions.map((i) => ({
		target: i.target.toLowerCase(),
		value: i.value.toString(),
		callData: i.callData.toLowerCase(),
	}));
}

/**
 * Canonical fingerprint of every field committed by the proposal signature.
 * It is deliberately derived rather than persisted so replay checks cannot
 * drift from the actual signed payload as the row shape evolves.
 */
export function signedProposalFingerprint(proposal: ProposalInput | Proposal): string {
	return JSON.stringify({
		subSolver: proposal.subSolver.toLowerCase(),
		orderUid: proposal.orderUid.toLowerCase(),
		orderUidHash: proposal.orderUidHash.toLowerCase(),
		sellToken: proposal.sellToken.toLowerCase(),
		buyToken: proposal.buyToken.toLowerCase(),
		sellAmount: proposal.sellAmount.toString(),
		minBuyAmount: proposal.minBuyAmount.toString(),
		quoteBuyAmount: proposal.quoteBuyAmount.toString(),
		interactions: interactionsToJson(proposal.interactions),
		interactionsHash: proposal.interactionsHash.toLowerCase(),
		validUntil: proposal.validUntil.toString(),
		nonce: proposal.nonce.toString(),
		signature: proposal.signature.toLowerCase(),
	});
}

// --- Writes ---

/**
 * Fields a caller must supply when creating a proposal. DB-managed fields
 * (createdAt, statusChangedAt, simulationFailureParams) are excluded because
 * they are set by the database or populated only after simulation.
 */
export type ProposalInput = Omit<
	Proposal,
	"id" | "createdAt" | "statusChangedAt" | "simulationFailureParams"
>;

export interface SolutionPrices {
	sellTokenRefPrice: string;
	surplusTokenRefPrice: string;
	auctionGasPrice: string;
	/** Clearing prices map: { [tokenAddress]: decimalString } */
	clearingPrices: Record<string, string>;
}

/**
 * Writes a candidate directly to proposals_log without going through the
 * proposals table. Used for candidates that are flushed from memory at
 * auction close, cancelled, or rejected inline (never inserted into proposals).
 */
export async function writeToLog(
	db: Db,
	id: number,
	proposal: ProposalInput,
	status: Status,
	rejectionReason: RejectionReason | null,
	simulationFailureParams: unknown | null,
): Promise<void> {
	const now = new Date();
	await db
		.insert(proposalsLog)
		.values({
			id,
			subSolver: proposal.subSolver.toLowerCase(),
			orderUid: proposal.orderUid.toLowerCase(),
			orderUidHash: proposal.orderUidHash.toLowerCase(),
			sellAmount: proposal.sellAmount.toString(),
			minBuyAmount: proposal.minBuyAmount.toString(),
			quoteBuyAmount: proposal.quoteBuyAmount.toString(),
			sellToken: proposal.sellToken.toLowerCase(),
			buyToken: proposal.buyToken.toLowerCase(),
			interactions: proposal.interactions.map((i) => ({
				target: i.target.toLowerCase(),
				value: i.value.toString(),
				callData: i.callData.toLowerCase(),
			})),
			interactionsHash: proposal.interactionsHash.toLowerCase(),
			validUntil: proposal.validUntil.toString(),
			nonce: proposal.nonce.toString(),
			signature: proposal.signature.toLowerCase(),
			status,
			rejectionReason,
			gasUsed: proposal.gasUsed != null ? Number(proposal.gasUsed) : null,
			trampoline: proposal.trampoline?.toLowerCase() ?? null,
			settlementTxHash: null,
			penaltyTxHash: null,
			simulationFailureParams: simulationFailureParams ?? null,
			sellTokenRefPrice: proposal.sellTokenRefPrice,
			validationSellTokenRefPrice: proposal.sellTokenRefPrice,
			buyTokenRefPrice: proposal.buyTokenRefPrice ?? null,
			auctionId: proposal.auctionId ?? null,
			createdAt: now,
			statusChangedAt: now,
		})
		.onConflictDoNothing();
}

/**
 * Inserts a candidate into the proposals table as submitted.
 * Called by /solve when a candidate is selected for a solution.
 */
export async function insertAsSubmitted(
	db: Db,
	candidate: Candidate,
	buyTokenRefPrice: string,
	solutionPrices: SolutionPrices,
	settlementPenaltyCap: bigint | null = null,
): Promise<void> {
	await db.insert(proposals).values({
		id: candidate.id,
		subSolver: candidate.subSolver.toLowerCase(),
		orderUid: candidate.orderUid.toLowerCase(),
		orderUidHash: candidate.orderUidHash.toLowerCase(),
		sellAmount: candidate.sellAmount.toString(),
		minBuyAmount: candidate.minBuyAmount.toString(),
		quoteBuyAmount: candidate.quoteBuyAmount.toString(),
		sellToken: candidate.sellToken.toLowerCase(),
		buyToken: candidate.buyToken.toLowerCase(),
		interactions: candidate.interactions.map((i) => ({
			target: i.target.toLowerCase(),
			value: i.value.toString(),
			callData: i.callData.toLowerCase(),
		})),
		interactionsHash: candidate.interactionsHash.toLowerCase(),
		validUntil: candidate.validUntil.toString(),
		nonce: candidate.nonce.toString(),
		signature: candidate.signature.toLowerCase(),
		status: "submitted",
		rejectionReason: null,
		gasUsed: Number(candidate.gasUsed),
		trampoline: candidate.trampoline.toLowerCase(),
		simulationBuyAmount: candidate.simulationBuyAmount?.toString() ?? null,
		sellTokenRefPrice: solutionPrices.sellTokenRefPrice,
		validationSellTokenRefPrice: candidate.sellTokenRefPrice,
		buyTokenRefPrice,
		settlementPenaltyCap: settlementPenaltyCap?.toString() ?? null,
		surplusTokenRefPrice: solutionPrices.surplusTokenRefPrice,
		auctionGasPrice: solutionPrices.auctionGasPrice,
		clearingPrices: solutionPrices.clearingPrices,
		auctionId: candidate.auctionId,
		createdAt: candidate.createdAt,
	});
}

export async function transition(
	db: Db,
	proposal: Proposal,
	toStatus: Status,
): Promise<{ auditEvent: AuditEvent } | StoreError> {
	const result = await db
		.update(proposals)
		.set({ status: toStatus, statusChangedAt: sql`now()` })
		.where(and(eq(proposals.id, proposal.id), eq(proposals.status, proposal.status)))
		.returning({ id: proposals.id });

	if (result.length === 0) {
		return {
			kind: "staleTransition",
			id: proposal.id,
			expected: proposal.status,
			actual: null,
		};
	}

	const auditEvent: AuditEvent = {
		occurredAt: new Date(),
		kind: {
			type: "statusChanged",
			proposalId: proposal.id,
			subSolver: proposal.subSolver,
			orderUid: proposal.orderUid,
			from: proposal.status,
			to: toStatus,
			rejectionReason: null,
			settlementTxHash: null,
		},
	};

	return { auditEvent };
}

export async function applySettlementOutcome(
	db: Db,
	proposal: Proposal,
	outcome: SettlementOutcome,
): Promise<{ auditEvent: AuditEvent | null; cancelledAuditEvents: AuditEvent[] } | StoreError> {
	const result = await db.transaction(async (tx) => {
		const [locked] = await tx
			.select({
				status: proposals.status,
				rejectionReason: proposals.rejectionReason,
				subSolver: proposals.subSolver,
				orderUid: proposals.orderUid,
			})
			.from(proposals)
			.where(eq(proposals.id, proposal.id))
			.for("update");

		if (!locked) {
			return { kind: "notFound" as const, id: proposal.id };
		}

		const from = locked.status as Status;
		let toStatus: Status | null = null;
		let txHash: Hex | null = null;

		// In the new design only `submitted` proposals are in the proposals table.
		switch (outcome.kind) {
			case "started":
				// No-op: no separate executing state; proposal remains submitted.
				break;
			case "succeeded":
				if (from === "submitted") {
					toStatus = "settled";
					txHash = outcome.txHash;
				}
				break;
			case "reverted":
				if (from === "submitted") {
					toStatus = "settleFailed";
					txHash = outcome.txHash;
				}
				break;
			case "abandoned":
				if (from === "submitted") {
					toStatus = "lost";
				}
				break;
		}

		if (!toStatus) {
			return { auditEvent: null, cancelledAuditEvents: [] };
		}

		await tx
			.update(proposals)
			.set({
				status: toStatus,
				...(txHash ? { settlementTxHash: txHash.toLowerCase() } : {}),
				...(outcome.kind === "reverted"
					? { settlementPenaltyCap: proposal.settlementPenaltyCap?.toString() ?? null }
					: {}),
				// Abandonment is an operational loss. Financial eligibility lives in
				// settlement_attempts and requires separate driver evidence.
				...(toStatus === "lost" ? { rejectionReason: "UnknownOutput" } : {}),
				statusChangedAt: sql`now()`,
			})
			.where(eq(proposals.id, proposal.id));

		// On success, cancel any other submitted proposals for the same order.
		const cancelled =
			outcome.kind === "succeeded"
				? await tx
						.select({ id: proposals.id, status: proposals.status })
						.from(proposals)
						.where(
							and(
								eq(proposals.subSolver, locked.subSolver),
								eq(proposals.orderUid, locked.orderUid),
								sql`${proposals.id} <> ${proposal.id}`,
								eq(proposals.status, "submitted"),
							),
						)
						.for("update")
				: [];

		if (cancelled.length > 0) {
			await tx
				.update(proposals)
				.set({ status: "cancelled" as Status, statusChangedAt: sql`now()` })
				.where(
					inArray(
						proposals.id,
						cancelled.map((sibling) => sibling.id),
					),
				);
		}

		// Delete terminal rows immediately so the proposals table holds only
		// submitted proposals. The trigger has already mirrored the final state
		// to proposals_log. Settled proposals stay until the buffer accounting
		// worker processes them.
		if (toStatus === "lost" || toStatus === "settleFailed") {
			await tx.delete(proposals).where(eq(proposals.id, proposal.id));
		}

		const auditEvent: AuditEvent = {
			occurredAt: new Date(),
			kind: {
				type: "statusChanged",
				proposalId: proposal.id,
				subSolver: proposal.subSolver,
				orderUid: proposal.orderUid,
				from,
				to: toStatus,
				rejectionReason: null,
				settlementTxHash: txHash,
			},
		};

		return {
			auditEvent,
			cancelledAuditEvents: cancelled.map((sibling) => ({
				occurredAt: new Date(),
				kind: {
					type: "statusChanged" as const,
					proposalId: sibling.id,
					subSolver: locked.subSolver as Address,
					orderUid: locked.orderUid,
					from: sibling.status as Status,
					to: "cancelled" as Status,
					rejectionReason: null,
					settlementTxHash: null,
				},
			})),
		};
	});

	return result;
}

export async function recordPenalty(
	db: Db,
	proposal: Proposal,
	amount: bigint,
	penaltyTxHash: Hex,
): Promise<{ auditEvent: AuditEvent } | StoreError> {
	// settleFailed live rows are deleted immediately; update proposals_log instead.
	// Guard on penalty_tx_hash IS NULL for idempotency — a debit that landed but
	// whose record call was retried must not overwrite the first hash.
	const result = await db
		.update(proposalsLog)
		.set({ penaltyTxHash: penaltyTxHash.toLowerCase() })
		.where(
			and(
				eq(proposalsLog.id, proposal.id),
				eq(proposalsLog.status, "settleFailed"),
				sql`${proposalsLog.penaltyTxHash} IS NULL`,
			),
		)
		.returning({ id: proposalsLog.id });

	if (result.length === 0) {
		return {
			kind: "staleTransition",
			id: proposal.id,
			expected: "settleFailed",
			actual: null,
		};
	}

	const auditEvent: AuditEvent = {
		occurredAt: new Date(),
		kind: {
			type: "penalized",
			proposalId: proposal.id,
			subSolver: proposal.subSolver,
			orderUid: proposal.orderUid,
			amount,
			settlementTxHash: proposal.settlementTxHash,
			penaltyTxHash,
		},
	};

	return { auditEvent };
}

/**
 * Redacts bulk debug data from old `proposals_log` rows to keep the table lean.
 * Sets `interactions` to `[]` and `simulation_failure_params` to `null` for rows
 * whose `created_at` is older than `olderThanSecs`. The rest of the row (amounts,
 * tokens, status, rejection reason, tx hashes, gas) is preserved forever.
 *
 * Returns the number of rows updated.
 */
export async function redactOldLogEntries(db: Db, olderThanSecs: number): Promise<number> {
	const result = await db
		.update(proposalsLog)
		.set({
			interactions: sql`'[]'::jsonb`,
			simulationFailureParams: null,
		})
		.where(
			and(
				sql`created_at < now() - make_interval(secs => ${olderThanSecs})`,
				or(sql`jsonb_array_length(interactions) > 0`, sql`simulation_failure_params is not null`),
			),
		)
		.returning({ id: proposalsLog.id });

	return result.length;
}

/**
 * Returns the distinct set of all sub-solver addresses that have ever submitted
 * a proposal. Used to prefetch escrow balances at /solve arrival.
 */
export async function allSubSolvers(db: Db): Promise<Address[]> {
	const rows = await db.selectDistinct({ subSolver: proposals.subSolver }).from(proposals);
	return rows.map((r) => r.subSolver as Address);
}

// --- Reads ---

export async function get(db: Db, id: number): Promise<Proposal | null> {
	if (!isStorableId(id)) return null;
	const [row] = await db.select().from(proposals).where(eq(proposals.id, id));
	if (!row) return null;
	return rowToProposal(row);
}

export async function getForOwner(
	db: Db,
	id: number,
	subSolver: Address,
): Promise<Proposal | StoreError> {
	if (!isStorableId(id)) {
		return { kind: "notFound", id };
	}

	const [row] = await db
		.select()
		.from(proposals)
		.where(and(eq(proposals.id, id), eq(proposals.subSolver, subSolver.toLowerCase())));

	if (row) return rowToProposal(row);

	// Proposal may have been swept from the active store — check the permanent log.
	const [logRow] = await db
		.select()
		.from(proposalsLog)
		.where(and(eq(proposalsLog.id, id), eq(proposalsLog.subSolver, subSolver.toLowerCase())));

	if (!logRow) {
		return { kind: "notFound", id };
	}
	return rowToProposal(logRow);
}

export async function listByOrderUidForOwner(
	db: Db,
	orderUid: string,
	owner: Address,
	includeArchived = false,
): Promise<Proposal[]> {
	if (includeArchived) {
		const rows = await db
			.select()
			.from(proposalsLog)
			.where(
				and(
					eq(proposalsLog.orderUid, orderUid.toLowerCase()),
					eq(proposalsLog.subSolver, owner.toLowerCase()),
				),
			)
			.orderBy(desc(proposalsLog.id));
		return rows.map(tryRowToProposal).filter((p): p is Proposal => p !== null);
	}

	const rows = await db
		.select()
		.from(proposals)
		.where(
			and(
				eq(proposals.orderUid, orderUid.toLowerCase()),
				eq(proposals.subSolver, owner.toLowerCase()),
				eq(proposals.status, "submitted"),
			),
		)
		.orderBy(proposals.id);

	return rows.map(tryRowToProposal).filter((p): p is Proposal => p !== null);
}

export async function listBySubSolver(
	db: Db,
	subSolver: Address,
	includeArchived = false,
): Promise<Proposal[]> {
	if (includeArchived) {
		const rows = await db
			.select()
			.from(proposalsLog)
			.where(eq(proposalsLog.subSolver, subSolver.toLowerCase()))
			.orderBy(desc(proposalsLog.id));
		return rows.map(tryRowToProposal).filter((p): p is Proposal => p !== null);
	}

	const rows = await db
		.select()
		.from(proposals)
		.where(and(eq(proposals.subSolver, subSolver.toLowerCase()), eq(proposals.status, "submitted")))
		.orderBy(proposals.id);

	return rows.map(tryRowToProposal).filter((p): p is Proposal => p !== null);
}

/**
 * Returns submitted proposal data and outstanding buffer balance for a subsolver.
 * Used by Gate 2 of the cumulative exposure check (CIP-87).
 *
 * In the new design candidates live in memory and are not yet in the DB.
 * The caller (validator) adds the current candidate's exposure itself; only
 * proposals already `submitted` to the driver count here.
 */
export async function fetchInflightDataBySubSolver(
	db: Db,
	subSolver: Address,
): Promise<{
	proposals: { id: number; gasUsed: bigint | null; sellAmountNative: bigint | null }[];
	bufferBalance: bigint;
}> {
	const [proposalRows, bufferRows] = await Promise.all([
		db
			.select({
				id: proposals.id,
				gasUsed: proposals.gasUsed,
				sellAmount: proposals.sellAmount,
				sellTokenRefPrice: proposals.validationSellTokenRefPrice,
			})
			.from(proposals)
			.where(
				and(eq(proposals.subSolver, subSolver.toLowerCase()), eq(proposals.status, "submitted")),
			),
		db
			.select({ nativeTokenAmount: bufferEntries.nativeTokenAmount })
			.from(bufferEntries)
			.where(
				and(eq(bufferEntries.subSolver, subSolver.toLowerCase()), eq(bufferEntries.cleared, false)),
			),
	]);

	const bufferBalance = bufferRows.reduce((sum, r) => sum + BigInt(r.nativeTokenAmount), 0n);

	const proposalData = proposalRows.map((r) => {
		const gasUsed = r.gasUsed != null ? BigInt(r.gasUsed) : null;
		let sellAmountNative: bigint | null = null;
		if (r.sellTokenRefPrice != null && r.sellTokenRefPrice !== "0") {
			sellAmountNative = nativeSellValue(BigInt(r.sellAmount), BigInt(r.sellTokenRefPrice));
		}
		return { id: r.id, gasUsed, sellAmountNative };
	});

	return { proposals: proposalData, bufferBalance };
}

export async function snapshotByStatuses(db: Db, statuses: Status[]): Promise<Proposal[]> {
	const rows = await db
		.select()
		.from(proposals)
		.where(inArray(proposals.status, statuses))
		.orderBy(proposals.id);

	return rows.map(tryRowToProposal).filter((p): p is Proposal => p !== null);
}

/**
 * Looks up a proposal by ID in both the proposals table and proposals_log.
 * Used by /notify to find proposals even after the live row has been deleted.
 */
export async function getIncludingLog(db: Db, id: number): Promise<Proposal | null> {
	if (!isStorableId(id)) return null;

	const [liveRow] = await db.select().from(proposals).where(eq(proposals.id, id));
	if (liveRow) return tryRowToProposal(liveRow);

	const [logRow] = await db.select().from(proposalsLog).where(eq(proposalsLog.id, id));
	return logRow ? tryRowToProposal(logRow) : null;
}

/**
 * Returns submitted proposals whose statusChangedAt is older than `windowMs`
 * milliseconds. Used by the outcome worker to detect lost proposals.
 */
export async function fetchStaleSubmitted(
	db: Db,
	windowMs: number,
): Promise<{ id: number; subSolver: Address; orderUid: string }[]> {
	const rows = await db
		.select({
			id: proposals.id,
			subSolver: proposals.subSolver,
			orderUid: proposals.orderUid,
		})
		.from(proposals)
		.where(
			and(
				eq(proposals.status, "submitted"),
				sql`${proposals.statusChangedAt} < now() - (${windowMs} || ' milliseconds')::interval`,
			),
		)
		.orderBy(proposals.id);

	return rows.map((r) => ({
		id: r.id,
		subSolver: r.subSolver as Address,
		orderUid: r.orderUid,
	}));
}

/**
 * Marks a submitted proposal as `lost` with the given rejection reason.
 * Does not authorize a penalty. Deletes the live row (the trigger fires first,
 * preserving the final state in proposals_log).
 *
 * Called by the outcome worker. If the row is already gone or not in
 * `submitted` state, returns a staleTransition or notFound indicator.
 */
export async function applyLostOutcome(
	db: Db,
	proposalId: number,
	reason: RejectionReason,
): Promise<
	| { kind: "ok"; auditEvent: AuditEvent }
	| { kind: "notFound"; id: number }
	| { kind: "staleTransition"; id: number }
> {
	return db.transaction(async (tx) => {
		const [locked] = await tx
			.select()
			.from(proposals)
			.where(eq(proposals.id, proposalId))
			.for("update");

		if (!locked) return { kind: "notFound", id: proposalId };
		if (locked.status !== "submitted") return { kind: "staleTransition", id: proposalId };

		// Update first so the trigger captures the terminal state in proposals_log.
		await tx
			.update(proposals)
			.set({
				status: "lost" as Status,
				rejectionReason: reason,
				statusChangedAt: sql`now()`,
			})
			.where(eq(proposals.id, proposalId));

		// Delete the live row — proposals_log already has the updated state.
		await tx.delete(proposals).where(eq(proposals.id, proposalId));

		const auditEvent: AuditEvent = {
			occurredAt: new Date(),
			kind: {
				type: "statusChanged",
				proposalId,
				subSolver: locked.subSolver as Address,
				orderUid: locked.orderUid,
				from: "submitted",
				to: "lost",
				rejectionReason: reason,
				settlementTxHash: null,
			},
		};
		return { kind: "ok", auditEvent };
	});
}

/**
 * Late correction: a `/notify` success or revert arrived after the outcome
 * worker already marked the proposal `lost` and deleted the live row.
 * Updates proposals_log in place; the penalty worker will pick up settleFailed
 * rows with penalty_tx_hash IS NULL on its next tick.
 */
export async function applyLateLostCorrection(
	db: Db,
	proposalId: number,
	outcome: { kind: "succeeded"; txHash: Hex } | { kind: "reverted"; txHash: Hex },
): Promise<{ auditEvent: AuditEvent } | StoreError> {
	const toStatus =
		outcome.kind === "succeeded" ? ("settled" as Status) : ("settleFailed" as Status);

	return db.transaction(async (tx) => {
		const result = await tx
			.update(proposalsLog)
			.set({
				status: toStatus,
				settlementTxHash: outcome.txHash.toLowerCase(),
				statusChangedAt: sql`now()`,
			})
			.where(and(eq(proposalsLog.id, proposalId), eq(proposalsLog.status, "lost")))
			.returning({ subSolver: proposalsLog.subSolver, orderUid: proposalsLog.orderUid });

		if (result.length === 0) {
			return {
				kind: "staleTransition" as const,
				id: proposalId,
				expected: "lost",
				actual: null,
			};
		}

		// result.length === 0 is already handled above, so result[0] is always defined
		const row = result[0] as NonNullable<(typeof result)[0]>;

		const auditEvent: AuditEvent = {
			occurredAt: new Date(),
			kind: {
				type: "statusChanged",
				proposalId,
				subSolver: row.subSolver as Address,
				orderUid: row.orderUid,
				from: "lost",
				to: toStatus,
				rejectionReason: null,
				settlementTxHash: outcome.txHash,
			},
		};
		return { auditEvent };
	});
}

/**
 * Reads `settleFailed` proposals from proposals_log (the live row is deleted
 * immediately on settlement failure). Used by the penalty worker.
 */
export async function snapshotSettleFailedFromLog(db: Db): Promise<Proposal[]> {
	const rows = await db
		.select()
		.from(proposalsLog)
		.where(
			and(
				eq(proposalsLog.status, "settleFailed"),
				sql`${proposalsLog.penaltyTxHash} IS NULL`,
				notExists(
					db
						.select({ id: settlementAttempts.id })
						.from(settlementAttemptMembers)
						.innerJoin(
							settlementAttempts,
							eq(settlementAttempts.id, settlementAttemptMembers.attemptId),
						)
						.where(
							and(
								eq(settlementAttemptMembers.proposalId, proposalsLog.id),
								eq(settlementAttempts.status, "needs_reconciliation"),
							),
						),
				),
			),
		)
		.orderBy(proposalsLog.id);

	return rows.map(tryRowToProposal).filter((p): p is Proposal => p !== null);
}

// --- Buffer Entries ---

export interface BufferEntry {
	id: number;
	subSolver: Address;
	proposalId: number;
	orderUid: string;
	buyToken: Address;
	delta: string;
	gap: string;
	nativeTokenAmount: string;
	cleared: boolean;
	clearTxHash: string | null;
	createdAt: Date;
}

/** Checks whether a buffer entry already exists for a proposal. */
export async function bufferEntryExistsForProposal(db: Db, proposalId: number): Promise<boolean> {
	const rows = await db
		.select({ id: bufferEntries.id })
		.from(bufferEntries)
		.where(eq(bufferEntries.proposalId, proposalId))
		.limit(1);
	return rows.length > 0;
}

/** Inserts a buffer entry for a settled proposal. */
export async function insertBufferEntry(
	db: Db,
	entry: {
		subSolver: Address;
		proposalId: number;
		orderUid: string;
		buyToken: Address;
		delta: string;
		gap: string;
		nativeTokenAmount: string;
	},
): Promise<number> {
	const result = await db
		.insert(bufferEntries)
		.values({
			subSolver: entry.subSolver.toLowerCase(),
			proposalId: entry.proposalId,
			orderUid: entry.orderUid.toLowerCase(),
			buyToken: entry.buyToken.toLowerCase(),
			delta: entry.delta,
			gap: entry.gap,
			nativeTokenAmount: entry.nativeTokenAmount,
		})
		.returning({ id: bufferEntries.id });
	// biome-ignore lint/style/noNonNullAssertion: INSERT RETURNING always yields one row
	return result[0]!.id;
}

/** Returns all subsolver addresses that have uncleared buffer entries. */
export async function unclearedBufferSubSolvers(db: Db): Promise<Address[]> {
	const rows = await db
		.selectDistinct({ subSolver: bufferEntries.subSolver })
		.from(bufferEntries)
		.where(eq(bufferEntries.cleared, false));
	return rows.map((r) => r.subSolver as Address);
}

/** Returns the outstanding (uncleared) buffer balance for a subsolver in native token (as bigint). */
export async function outstandingBufferBalance(db: Db, subSolver: Address): Promise<bigint> {
	const rows = await db
		.select({
			total: sql<string>`COALESCE(SUM(CAST(${bufferEntries.nativeTokenAmount} AS numeric)), 0)`,
		})
		.from(bufferEntries)
		.where(
			and(eq(bufferEntries.subSolver, subSolver.toLowerCase()), eq(bufferEntries.cleared, false)),
		);
	return BigInt(rows[0]?.total ?? "0");
}

/** Returns all uncleared buffer entries for a subsolver. */
export async function unclearedBufferEntries(db: Db, subSolver: Address): Promise<BufferEntry[]> {
	const rows = await db
		.select()
		.from(bufferEntries)
		.where(
			and(eq(bufferEntries.subSolver, subSolver.toLowerCase()), eq(bufferEntries.cleared, false)),
		)
		.orderBy(bufferEntries.createdAt);
	return rows.map((r) => ({
		id: r.id,
		subSolver: r.subSolver as Address,
		proposalId: r.proposalId,
		orderUid: r.orderUid,
		buyToken: r.buyToken as Address,
		delta: r.delta,
		gap: r.gap,
		nativeTokenAmount: r.nativeTokenAmount,
		cleared: r.cleared,
		clearTxHash: r.clearTxHash,
		createdAt: r.createdAt,
	}));
}

/**
 * Marks all uncleared entries as in-flight (cleared=true, clear_tx_hash=NULL).
 * In-flight entries are excluded from balance computation, preventing double-debit
 * if the on-chain debit succeeds but the subsequent DB update fails.
 */
export async function markBufferEntriesInFlight(
	db: Db,
	subSolver: Address,
	entryIds?: number[],
): Promise<number> {
	if (entryIds?.length === 0) return 0;
	const result = await db
		.update(bufferEntries)
		.set({ cleared: true, clearTxHash: null })
		.where(
			and(
				eq(bufferEntries.subSolver, subSolver.toLowerCase()),
				eq(bufferEntries.cleared, false),
				...(entryIds ? [inArray(bufferEntries.id, entryIds)] : []),
			),
		)
		.returning({ id: bufferEntries.id });
	return result.length;
}

/** Finalizes in-flight entries with the actual debit tx hash. */
export async function finalizeBufferEntries(
	db: Db,
	subSolver: Address,
	entryIds: number[],
	clearTxHash: Hex,
): Promise<number> {
	if (entryIds.length === 0) return 0;
	const result = await db
		.update(bufferEntries)
		.set({ clearTxHash: clearTxHash.toLowerCase() })
		.where(
			and(
				eq(bufferEntries.subSolver, subSolver.toLowerCase()),
				eq(bufferEntries.cleared, true),
				inArray(bufferEntries.id, entryIds),
				sql`clear_tx_hash IS NULL`,
			),
		)
		.returning({ id: bufferEntries.id });
	return result.length;
}

/** Reverts in-flight entries back to uncleared (debit failed or was not attempted). */
export async function revertInFlightBufferEntries(db: Db, subSolver: Address): Promise<number> {
	const result = await db
		.update(bufferEntries)
		.set({ cleared: false })
		.where(
			and(
				eq(bufferEntries.subSolver, subSolver.toLowerCase()),
				eq(bufferEntries.cleared, true),
				sql`clear_tx_hash IS NULL`,
			),
		)
		.returning({ id: bufferEntries.id });
	return result.length;
}

/** Marks all uncleared entries for a subsolver as cleared with the given tx hash. */
export async function clearBufferEntries(
	db: Db,
	subSolver: Address,
	clearTxHash: Hex,
): Promise<number> {
	const result = await db
		.update(bufferEntries)
		.set({ cleared: true, clearTxHash: clearTxHash.toLowerCase() })
		.where(
			and(eq(bufferEntries.subSolver, subSolver.toLowerCase()), eq(bufferEntries.cleared, false)),
		)
		.returning({ id: bufferEntries.id });
	return result.length;
}

/** Explicit, evidence-backed liabilities; proposal loss is not eligibility. */
export const pendingPenalties = eligibleNonSettlementPenalties;
