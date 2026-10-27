import { and, eq, inArray, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { type Address, type Hex, keccak256 } from "viem";
import type { Db } from "../db/index.js";
import {
	debitOperations,
	proposals,
	proposalsLog,
	settlementAttemptMembers,
	settlementAttempts,
	settlementNotifications,
} from "../db/schema.js";
import { nonSettlementDebit } from "../domain/penalty.js";
import type { Notification } from "./api/types.js";

export const RETRY_RECONCILIATION_REASON = "Debit operation exhausted retries or requires review";

const POLICY_VERSION = "confirmed-abandonment-v1";
const abandonmentKinds = new Set(["cancelled", "expired", "fail"]);

/** Only complete, auction-scoped attribution can authorize a financial action. */
export async function recordSettlementNotification(
	db: Db,
	notification: Notification,
	logger?: Logger,
): Promise<boolean> {
	const auctionId = Number(notification.auctionId);
	const rawIds = notification.solutionId;
	const ids = [...new Set(Array.isArray(rawIds) ? rawIds : rawIds == null ? [] : [rawIds])].sort(
		(a, b) => a - b,
	);
	if (
		!notification.auctionId ||
		!/^\d+$/.test(notification.auctionId) ||
		!Number.isSafeInteger(auctionId) ||
		!ids.length ||
		ids.some((id) => !Number.isSafeInteger(id))
	)
		return false;
	const attemptKey = `auction:${auctionId}:solutions:${ids.join(",")}`;
	return db.transaction(async (tx) => {
		// Serialize notifications, including overlapping solution groups, across replicas.
		for (const id of ids) await tx.execute(sql`SELECT pg_advisory_xact_lock(${id}::bigint)`);
		// Log rows survive timeout reconciliation; bid metadata is immutable.
		const rows = await tx
			.select()
			.from(proposalsLog)
			.where(inArray(proposalsLog.id, ids))
			.orderBy(proposalsLog.id);
		const first = rows[0];
		if (
			!first ||
			rows.length !== ids.length ||
			rows.some(
				(row) =>
					row.auctionId !== auctionId ||
					row.subSolver !== first.subSolver ||
					row.clearingPrices === null,
			)
		)
			return false;
		const memberships = await tx
			.select()
			.from(settlementAttemptMembers)
			.where(inArray(settlementAttemptMembers.proposalId, ids))
			.orderBy(settlementAttemptMembers.attemptId);
		const existing = await tx
			.select()
			.from(settlementAttempts)
			.where(eq(settlementAttempts.attemptKey, attemptKey))
			.for("update");
		const current = existing[0];
		if (memberships.some((member) => member.attemptId !== current?.id)) {
			// Never turn overlapping single/merged notifications into separate charges.
			for (const member of memberships) {
				await tx
					.insert(settlementNotifications)
					.values({
						attemptId: member.attemptId,
						kind: notification.kind,
						transactionHash: notification.transaction?.toLowerCase() ?? "",
						payload: notification,
						solutionKey: attemptKey,
					})
					.onConflictDoNothing();
				await tx
					.update(settlementAttempts)
					.set({
						status: "needs_reconciliation",
						reconciliationReason: "Conflicting solution membership",
					})
					.where(eq(settlementAttempts.id, member.attemptId));
			}
			logger?.error({ attemptKey }, "conflicting settlement membership requires reconciliation");
			return false;
		}
		const [legacyDebit] = await tx
			.select()
			.from(debitOperations)
			.where(
				and(
					eq(debitOperations.sourceKind, "non-settlement"),
					sql`${debitOperations.sourceId} LIKE 'penalty:%'`,
					eq(debitOperations.subSolver, first.subSolver),
					eq(debitOperations.reason, keccak256(first.orderUid as Hex)),
					sql`${debitOperations.rawTransaction} IS NOT NULL`,
				),
			)
			.limit(1);
		const legacyCharge = first.penaltyTxHash !== null || legacyDebit !== undefined;
		const cap = first.settlementPenaltyCap;
		const validCap = cap !== null && /^\d+$/.test(cap);
		const [attempt] = current
			? [current]
			: await tx
					.insert(settlementAttempts)
					.values({
						attemptKey,
						auctionId,
						subSolver: first.subSolver,
						proposalId: first.id,
						orderUid: first.orderUid,
						penaltyCap: validCap ? cap : null,
						amount: validCap ? nonSettlementDebit(BigInt(cap)).toString() : null,
						policyVersion: POLICY_VERSION,
						penaltyTxHash: first.penaltyTxHash,
						// Solution merging is forbidden by this service. Preserve unexpected merged
						// evidence for review instead of inventing a cap or charging each member.
						...(legacyCharge || ids.length > 1 || !validCap
							? {
									status: "needs_reconciliation",
									reconciliationReason: legacyCharge
										? "Legacy abandonment debit requires review"
										: ids.length > 1
											? "Unexpected merged settlement"
											: "Missing penalty cap snapshot",
								}
							: {}),
					})
					.returning();
		if (!attempt) throw new Error("settlement attempt disappeared");
		if (!current)
			await tx
				.insert(settlementAttemptMembers)
				.values(ids.map((proposalId) => ({ attemptId: attempt.id, proposalId })));
		await tx
			.insert(settlementNotifications)
			.values({
				attemptId: attempt.id,
				kind: notification.kind,
				transactionHash: notification.transaction?.toLowerCase() ?? "",
				payload: notification,
				solutionKey: attemptKey,
			})
			.onConflictDoNothing();
		const startedAt =
			attempt.startedAt ?? (notification.kind === "settlementStarted" ? new Date() : null);
		const abandonedAt =
			attempt.abandonedAt ?? (abandonmentKinds.has(notification.kind) ? new Date() : null);
		const outcome =
			["success", "revert"].includes(notification.kind) && notification.transaction
				? notification.kind
				: attempt.outcome;
		let status = attempt.status;
		let reconciliationReason = attempt.reconciliationReason;
		if (outcome) {
			const [operation] = await tx
				.select()
				.from(debitOperations)
				.where(
					and(
						eq(debitOperations.sourceKind, "non-settlement"),
						eq(debitOperations.sourceId, `attempt:${attempt.id}`),
					),
				)
				.for("update");
			if (operation?.rawTransaction || attempt.penaltyTxHash) {
				status = "needs_reconciliation";
				reconciliationReason =
					"Settlement outcome conflicts with a signed or landed abandonment debit";
			} else if (status !== "needs_reconciliation") status = "cancelled";
			if (operation && operation.status !== "completed")
				await tx
					.update(debitOperations)
					.set({
						status: operation.rawTransaction ? "needs_reconciliation" : "cancelled",
						lastError: "Settlement outcome superseded abandonment",
						leaseOwner: null,
						leaseExpiresAt: null,
					})
					.where(eq(debitOperations.id, operation.id));
		} else if (
			status === "awaiting_evidence" &&
			startedAt &&
			abandonedAt &&
			attempt.amount !== null
		)
			status = BigInt(attempt.amount) > 0n ? "eligible" : "cancelled";
		await tx
			.update(settlementAttempts)
			.set({
				startedAt,
				abandonedAt,
				abandonmentKind:
					attempt.abandonmentKind ??
					(abandonmentKinds.has(notification.kind) ? notification.kind : null),
				outcome,
				status,
				reconciliationReason,
			})
			.where(eq(settlementAttempts.id, attempt.id));
		if (status === "needs_reconciliation")
			logger?.error(
				{ attemptId: attempt.id, reason: reconciliationReason },
				"settlement penalty requires reconciliation",
			);
		return true;
	});
}

export async function eligibleNonSettlementPenalties(db: Db) {
	const rows = await db
		.select()
		.from(settlementAttempts)
		.where(eq(settlementAttempts.status, "eligible"))
		.orderBy(settlementAttempts.id);
	return rows.map((row) => {
		if (row.amount === null || row.penaltyCap === null)
			throw new Error(`Eligible attempt ${row.id} has no financial snapshot`);
		return {
			id: row.id,
			proposalId: row.proposalId,
			subSolver: row.subSolver as Address,
			orderUid: row.orderUid,
			penaltyCap: row.penaltyCap === null ? null : BigInt(row.penaltyCap),
			amount: BigInt(row.amount),
		};
	});
}

/**
 * Serialize corrections and debit execution on the attempt row. Debit operation
 * writes commit independently: a crash rolls back this lock, never signed bytes.
 * The lock spans the chain edge so a correction cannot commit between the final
 * eligibility check and broadcast. No /solve request acquires this lock.
 */
export async function executeNonSettlementPenalty<T extends { operationId: number; owner: string }>(
	db: Db,
	id: number,
	debit: () => Promise<{ hash: Hex; value: T } | null>,
): Promise<T | null> {
	return db.transaction(async (tx) => {
		const [attempt] = await tx
			.select()
			.from(settlementAttempts)
			.where(eq(settlementAttempts.id, id))
			.for("update");
		if (attempt?.status !== "eligible") return null;
		const landed = await debit();
		if (!landed) {
			const [operation] = await tx
				.select()
				.from(debitOperations)
				.where(
					and(
						eq(debitOperations.sourceKind, "non-settlement"),
						eq(debitOperations.sourceId, `attempt:${id}`),
					),
				);
			if (operation?.status === "needs_reconciliation")
				await tx
					.update(settlementAttempts)
					.set({
						status: "needs_reconciliation",
						reconciliationReason: RETRY_RECONCILIATION_REASON,
					})
					.where(eq(settlementAttempts.id, id));
			return null;
		}
		await tx
			.update(settlementAttempts)
			.set({ status: "debited", penaltyTxHash: landed.hash.toLowerCase() })
			.where(eq(settlementAttempts.id, id));
		const members = await tx
			.select()
			.from(settlementAttemptMembers)
			.where(eq(settlementAttemptMembers.attemptId, id));
		// Update live rows first, matching lifecycle writers' lock order. Otherwise
		// a subsequent mirror trigger could erase the financial hash from the log.
		await tx
			.update(proposals)
			.set({ penaltyTxHash: landed.hash.toLowerCase() })
			.where(
				inArray(
					proposals.id,
					members.map((member) => member.proposalId),
				),
			);
		await tx
			.update(proposalsLog)
			.set({ penaltyTxHash: landed.hash.toLowerCase() })
			.where(
				inArray(
					proposalsLog.id,
					members.map((member) => member.proposalId),
				),
			);
		const completed = await tx
			.update(debitOperations)
			.set({ status: "completed", leaseOwner: null, leaseExpiresAt: null, nextRetryAt: null })
			.where(
				and(
					eq(debitOperations.id, landed.value.operationId),
					eq(debitOperations.leaseOwner, landed.value.owner),
				),
			)
			.returning({ id: debitOperations.id });
		if (!completed.length) throw new Error("Debit operation lease changed before finalization");
		return landed.value;
	});
}
