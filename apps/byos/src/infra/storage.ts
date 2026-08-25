import type { RejectionReason, Status } from "@byos/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Address, Hex } from "viem";
import type { Db } from "../db/index.js";
import { bufferEntries, penalties, proposals, solutions } from "../db/schema.js";
import type { AuditEvent } from "../domain/audit.js";
import type { PendingPenalty } from "../domain/penalty.js";
import type { Proposal, SettlementOutcome } from "../domain/proposal.js";
import type { Verdict } from "../domain/validator.js";

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

// --- Row Codec ---

type ProposalRow = typeof proposals.$inferSelect;

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
		pendingCancellation: row.pendingCancellation,
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
		callData: i.callData,
	}));
}

// --- Writes ---

export async function insert(
	db: Db,
	proposal: Omit<Proposal, "id">,
): Promise<{ id: number; auditEvent: AuditEvent }> {
	const [row] = await db
		.insert(proposals)
		.values({
			subSolver: proposal.subSolver.toLowerCase(),
			orderUid: proposal.orderUid.toLowerCase(),
			orderUidHash: proposal.orderUidHash.toLowerCase(),
			sellAmount: proposal.sellAmount.toString(),
			minBuyAmount: proposal.minBuyAmount.toString(),
			quoteBuyAmount: proposal.quoteBuyAmount.toString(),
			sellToken: proposal.sellToken.toLowerCase(),
			buyToken: proposal.buyToken.toLowerCase(),
			interactions: interactionsToJson(proposal.interactions),
			interactionsHash: proposal.interactionsHash.toLowerCase(),
			validUntil: proposal.validUntil.toString(),
			nonce: proposal.nonce.toString(),
			signature: proposal.signature,
			status: proposal.status,
			rejectionReason: proposal.rejectionReason,
			gasUsed: proposal.gasUsed != null ? Number(proposal.gasUsed) : null,
			trampoline: proposal.trampoline?.toLowerCase() ?? null,
			settlementTxHash: proposal.settlementTxHash?.toLowerCase() ?? null,
			penaltyTxHash: proposal.penaltyTxHash?.toLowerCase() ?? null,
		})
		.returning({ id: proposals.id });

	// INSERT ... RETURNING always returns exactly one row
	if (!row) throw new Error("INSERT RETURNING returned no rows");
	const { id } = row;
	const fullProposal: Proposal = { ...proposal, id };

	const auditEvent: AuditEvent = {
		occurredAt: new Date(),
		kind: { type: "received", proposal: fullProposal },
	};

	return { id, auditEvent };
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

export async function resolveVerdict(
	db: Db,
	id: number,
	verdict: Verdict,
): Promise<{ status: Status; auditEvent: AuditEvent | null } | StoreError> {
	// Use raw SQL for SELECT ... FOR UPDATE inside a transaction
	const result = await db.transaction(async (tx) => {
		const [locked] = await tx
			.select({
				status: proposals.status,
				subSolver: proposals.subSolver,
				orderUid: proposals.orderUid,
			})
			.from(proposals)
			.where(eq(proposals.id, id))
			.for("update");

		if (!locked) {
			return { kind: "notFound" as const, id };
		}

		// Decided under the lock, not from the caller's snapshot: a cancellation
		// that landed while the validator was simulating must win, or the verdict
		// resurrects a proposal its owner already withdrew.
		const from = locked.status as Status;
		if (from !== "submitted" && from !== "active") {
			return { kind: "staleTransition" as const, id, expected: "submitted|active", actual: from };
		}

		let toStatus: Status;
		let rejectionReason: RejectionReason | null = null;
		let gasUsed: number | null = null;
		let trampoline: string | null = null;
		let sellToken: string | null = null;
		let buyToken: string | null = null;

		switch (verdict.kind) {
			case "accept":
				toStatus = "active";
				if (verdict.simulation) {
					gasUsed = Number(verdict.simulation.gasUsed);
					trampoline = verdict.simulation.trampoline.toLowerCase();
					sellToken = verdict.simulation.sellToken.toLowerCase();
					buyToken = verdict.simulation.buyToken.toLowerCase();
				}
				break;
			case "reject":
				toStatus = "rejected";
				rejectionReason = verdict.reason;
				break;
			case "simFailed":
				toStatus = "simFailed";
				break;
		}

		const statusChanged = from !== toStatus;

		await tx
			.update(proposals)
			.set({
				status: toStatus,
				rejectionReason,
				...(gasUsed != null ? { gasUsed } : {}),
				...(trampoline ? { trampoline } : {}),
				...(sellToken ? { sellToken } : {}),
				...(buyToken ? { buyToken } : {}),
				...(statusChanged ? { statusChangedAt: sql`now()` } : {}),
			})
			.where(eq(proposals.id, id));

		const auditEvent: AuditEvent | null = statusChanged
			? {
					occurredAt: new Date(),
					kind: {
						type: "statusChanged",
						proposalId: id,
						subSolver: locked.subSolver as Address,
						orderUid: locked.orderUid,
						from,
						to: toStatus,
						rejectionReason,
						settlementTxHash: null,
					},
				}
			: null;

		return { status: toStatus, auditEvent };
	});

	return result;
}

export async function cancel(
	db: Db,
	id: number,
	subSolver: Address,
): Promise<{ auditEvent: AuditEvent } | { deferred: true; auditEvent: AuditEvent } | StoreError> {
	if (!isStorableId(id)) {
		return { kind: "notFound", id };
	}

	const result = await db.transaction(async (tx) => {
		const [locked] = await tx
			.select({
				status: proposals.status,
				subSolver: proposals.subSolver,
				orderUid: proposals.orderUid,
			})
			.from(proposals)
			.where(eq(proposals.id, id))
			.for("update");

		if (!locked) {
			return { kind: "notFound" as const, id };
		}
		if (locked.subSolver.toLowerCase() !== subSolver.toLowerCase()) {
			return { kind: "notOwner" as const, id, owner: subSolver };
		}

		if (locked.status === "submitted" || locked.status === "active") {
			await tx
				.update(proposals)
				.set({ status: "cancelled" as Status, statusChangedAt: sql`now()` })
				.where(eq(proposals.id, id));

			const auditEvent: AuditEvent = {
				occurredAt: new Date(),
				kind: {
					type: "cancelled",
					proposalId: id,
					subSolver,
					orderUid: locked.orderUid,
				},
			};

			return { auditEvent };
		}

		if (locked.status === "executing") {
			await tx.update(proposals).set({ pendingCancellation: true }).where(eq(proposals.id, id));

			const auditEvent: AuditEvent = {
				occurredAt: new Date(),
				kind: {
					type: "cancellationDeferred",
					proposalId: id,
					subSolver,
					orderUid: locked.orderUid,
				},
			};

			return { deferred: true, auditEvent };
		}

		return {
			kind: "staleTransition" as const,
			id,
			expected: "submitted|active|executing",
			actual: locked.status,
		};
	});

	return result;
}

export async function applySettlementOutcome(
	db: Db,
	proposal: Proposal,
	outcome: SettlementOutcome,
): Promise<{ auditEvent: AuditEvent | null; insertedPenalty: boolean } | StoreError> {
	const result = await db.transaction(async (tx) => {
		const [locked] = await tx
			.select({
				status: proposals.status,
				pendingCancellation: proposals.pendingCancellation,
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
		let insertPenalty = false;

		switch (outcome.kind) {
			case "started":
				if (from === "active") toStatus = "executing";
				break;
			case "succeeded":
				if (from === "active" || from === "executing") {
					toStatus = "settled";
					txHash = outcome.txHash;
				}
				break;
			case "reverted":
				if (from === "active" || from === "executing") {
					toStatus = "settleFailed";
					txHash = outcome.txHash;
				}
				break;
			case "abandoned":
				if (from === "executing") {
					toStatus = locked.pendingCancellation ? "cancelled" : "active";
					insertPenalty = true;
				}
				break;
		}

		if (!toStatus) {
			return { auditEvent: null, insertedPenalty: false };
		}

		await tx
			.update(proposals)
			.set({
				status: toStatus,
				pendingCancellation: false,
				...(txHash ? { settlementTxHash: txHash.toLowerCase() } : {}),
				statusChangedAt: sql`now()`,
			})
			.where(eq(proposals.id, proposal.id));

		if (insertPenalty) {
			await tx.insert(penalties).values({
				proposalId: proposal.id,
				subSolver: proposal.subSolver.toLowerCase(),
				orderUid: proposal.orderUid.toLowerCase(),
			});
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

		return { auditEvent, insertedPenalty: insertPenalty };
	});

	return result;
}

export async function recordPenalty(
	db: Db,
	proposal: Proposal,
	amount: bigint,
	penaltyTxHash: Hex,
	fromStatus: Status = "settleFailed",
): Promise<{ auditEvent: AuditEvent } | StoreError> {
	const result = await db
		.update(proposals)
		.set({
			status: "penalized" as Status,
			penaltyTxHash: penaltyTxHash.toLowerCase(),
			statusChangedAt: sql`now()`,
		})
		.where(and(eq(proposals.id, proposal.id), eq(proposals.status, fromStatus)))
		.returning({ id: proposals.id });

	if (result.length === 0) {
		return {
			kind: "staleTransition",
			id: proposal.id,
			expected: fromStatus,
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

export async function releaseStaleExecuting(db: Db, olderThanSecs: number): Promise<AuditEvent[]> {
	const staleCondition = and(
		eq(proposals.status, "executing"),
		sql`status_changed_at < now() - make_interval(secs => ${olderThanSecs})`,
	);

	const released = await db
		.update(proposals)
		.set({ status: "active" as Status, statusChangedAt: sql`now()` })
		.where(and(staleCondition, eq(proposals.pendingCancellation, false)))
		.returning({
			id: proposals.id,
			subSolver: proposals.subSolver,
			orderUid: proposals.orderUid,
		});

	const cancelled = await db
		.update(proposals)
		.set({
			status: "cancelled" as Status,
			pendingCancellation: false,
			statusChangedAt: sql`now()`,
		})
		.where(and(staleCondition, eq(proposals.pendingCancellation, true)))
		.returning({
			id: proposals.id,
			subSolver: proposals.subSolver,
			orderUid: proposals.orderUid,
		});

	return [
		...released.map((r) => ({
			occurredAt: new Date(),
			kind: {
				type: "statusChanged" as const,
				proposalId: r.id,
				subSolver: r.subSolver as Address,
				orderUid: r.orderUid,
				from: "executing" as Status,
				to: "active" as Status,
				rejectionReason: null,
				settlementTxHash: null,
			},
		})),
		...cancelled.map((r) => ({
			occurredAt: new Date(),
			kind: {
				type: "statusChanged" as const,
				proposalId: r.id,
				subSolver: r.subSolver as Address,
				orderUid: r.orderUid,
				from: "executing" as Status,
				to: "cancelled" as Status,
				rejectionReason: null,
				settlementTxHash: null,
			},
		})),
	];
}

const SWEEPABLE_STATUSES: Status[] = ["rejected", "simFailed", "expired", "cancelled"];

export async function sweepDropped(db: Db, olderThanSecs: number): Promise<number> {
	const result = await db
		.delete(proposals)
		.where(
			and(
				inArray(proposals.status, SWEEPABLE_STATUSES),
				sql`status_changed_at < now() - make_interval(secs => ${olderThanSecs})`,
			),
		)
		.returning({ id: proposals.id });

	return result.length;
}

export async function recordSolution(
	db: Db,
	auctionId: number,
	solutionId: number,
	proposalId: number,
	buyTokenRefPrice: string,
): Promise<void> {
	await db
		.insert(solutions)
		.values({ auctionId, solutionId, proposalId, buyTokenRefPrice })
		.onConflictDoUpdate({
			target: [solutions.auctionId, solutions.solutionId],
			set: { proposalId, buyTokenRefPrice },
		});
}

/** Fetches the buy-token reference price stored at solution-build time for a proposal. */
export async function buyTokenRefPriceForProposal(
	db: Db,
	proposalId: number,
): Promise<string | null> {
	const rows = await db
		.select({ buyTokenRefPrice: solutions.buyTokenRefPrice })
		.from(solutions)
		.where(eq(solutions.proposalId, proposalId))
		.limit(1);
	return rows[0]?.buyTokenRefPrice ?? null;
}

export async function recordNonSettlementDebit(
	db: Db,
	penalty: PendingPenalty,
	amount: bigint,
	penaltyTxHash: Hex,
): Promise<AuditEvent> {
	await db
		.update(penalties)
		.set({ penaltyTxHash: penaltyTxHash.toLowerCase() })
		.where(eq(penalties.id, penalty.id));

	return {
		occurredAt: new Date(),
		kind: {
			type: "nonSettlementDebited",
			proposalId: penalty.proposalId,
			subSolver: penalty.subSolver as Address,
			orderUid: penalty.orderUid,
			amount,
			penaltyTxHash,
		},
	};
}

export async function queueNonSettlementPenalty(db: Db, proposal: Proposal): Promise<void> {
	await db.insert(penalties).values({
		proposalId: proposal.id,
		subSolver: proposal.subSolver.toLowerCase(),
		orderUid: proposal.orderUid.toLowerCase(),
	});
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

	if (!row) {
		return { kind: "notFound", id };
	}
	return rowToProposal(row);
}

export async function listByOrderUid(db: Db, orderUid: string): Promise<Proposal[]> {
	const rows = await db
		.select()
		.from(proposals)
		.where(and(eq(proposals.orderUid, orderUid.toLowerCase()), eq(proposals.status, "active")))
		.orderBy(proposals.id);

	return rows.map(tryRowToProposal).filter((p): p is Proposal => p !== null);
}

export async function listByOrderUidForOwner(
	db: Db,
	orderUid: string,
	owner: Address,
): Promise<Proposal[]> {
	const rows = await db
		.select()
		.from(proposals)
		.where(
			and(
				eq(proposals.orderUid, orderUid.toLowerCase()),
				eq(proposals.subSolver, owner.toLowerCase()),
				eq(proposals.status, "active"),
			),
		)
		.orderBy(proposals.id);

	return rows.map(tryRowToProposal).filter((p): p is Proposal => p !== null);
}

export async function listBySubSolver(db: Db, subSolver: Address): Promise<Proposal[]> {
	const rows = await db
		.select()
		.from(proposals)
		.where(
			and(
				eq(proposals.subSolver, subSolver.toLowerCase()),
				inArray(proposals.status, ["submitted", "active"]),
			),
		)
		.orderBy(proposals.id);

	return rows.map(tryRowToProposal).filter((p): p is Proposal => p !== null);
}

/**
 * Returns the gas used for all proposals of a sub-solver that are in-flight
 * (`submitted`, `active`, or `executing`), excluding one proposal by id (the
 * one being validated). Used by EscrowValidator to compute cumulative exposure.
 *
 * `submitted` proposals have not been simulated yet, so their `gasUsed` is
 * null — they contribute 0 gas to the exposure (minCollateral only).
 * `active` proposals have been simulated and carry a real gas estimate.
 * `executing` proposals may or may not have a gas estimate; same rule applies.
 */
export async function inflightGasUsedBySubSolver(
	db: Db,
	subSolver: Address,
	excludeId: number,
): Promise<(bigint | null)[]> {
	const rows = await db
		.select({ gasUsed: proposals.gasUsed })
		.from(proposals)
		.where(
			and(
				eq(proposals.subSolver, subSolver.toLowerCase()),
				inArray(proposals.status, ["submitted", "active", "executing"]),
				sql`${proposals.id} != ${excludeId}`,
			),
		);

	return rows.map((r) => (r.gasUsed != null ? BigInt(r.gasUsed) : null));
}

export async function activeByOrderUids(
	db: Db,
	orderUids: string[],
): Promise<Map<string, Proposal[]>> {
	if (orderUids.length === 0) return new Map();

	const lowerUids = orderUids.map((u) => u.toLowerCase());
	const rows = await db
		.select()
		.from(proposals)
		.where(and(inArray(proposals.orderUid, lowerUids), eq(proposals.status, "active")))
		.orderBy(proposals.id);

	const grouped = new Map<string, Proposal[]>();
	for (const row of rows) {
		const p = tryRowToProposal(row);
		if (!p) continue;
		const key = p.orderUid.toLowerCase();
		const list = grouped.get(key);
		if (list) {
			list.push(p);
		} else {
			grouped.set(key, [p]);
		}
	}

	return grouped;
}

export async function snapshotByStatuses(db: Db, statuses: Status[]): Promise<Proposal[]> {
	const rows = await db
		.select()
		.from(proposals)
		.where(inArray(proposals.status, statuses))
		.orderBy(proposals.id);

	return rows.map(tryRowToProposal).filter((p): p is Proposal => p !== null);
}

export async function solutionProposals(
	db: Db,
	auctionId: number,
	solutionIds: number[],
): Promise<Proposal[]> {
	if (solutionIds.length === 0) return [];

	const rows = await db
		.select({
			id: proposals.id,
			subSolver: proposals.subSolver,
			orderUid: proposals.orderUid,
			orderUidHash: proposals.orderUidHash,
			sellAmount: proposals.sellAmount,
			minBuyAmount: proposals.minBuyAmount,
			quoteBuyAmount: proposals.quoteBuyAmount,
			sellToken: proposals.sellToken,
			buyToken: proposals.buyToken,
			interactions: proposals.interactions,
			interactionsHash: proposals.interactionsHash,
			validUntil: proposals.validUntil,
			nonce: proposals.nonce,
			signature: proposals.signature,
			status: proposals.status,
			rejectionReason: proposals.rejectionReason,
			gasUsed: proposals.gasUsed,
			trampoline: proposals.trampoline,
			settlementTxHash: proposals.settlementTxHash,
			penaltyTxHash: proposals.penaltyTxHash,
			pendingCancellation: proposals.pendingCancellation,
			createdAt: proposals.createdAt,
			statusChangedAt: proposals.statusChangedAt,
		})
		.from(proposals)
		.innerJoin(solutions, eq(solutions.proposalId, proposals.id))
		.where(and(eq(solutions.auctionId, auctionId), inArray(solutions.solutionId, solutionIds)))
		.orderBy(proposals.id);

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
export async function markBufferEntriesInFlight(db: Db, subSolver: Address): Promise<number> {
	const result = await db
		.update(bufferEntries)
		.set({ cleared: true, clearTxHash: null })
		.where(
			and(eq(bufferEntries.subSolver, subSolver.toLowerCase()), eq(bufferEntries.cleared, false)),
		)
		.returning({ id: bufferEntries.id });
	return result.length;
}

/** Finalizes in-flight entries with the actual debit tx hash. */
export async function finalizeBufferEntries(
	db: Db,
	subSolver: Address,
	clearTxHash: Hex,
): Promise<number> {
	const result = await db
		.update(bufferEntries)
		.set({ clearTxHash: clearTxHash.toLowerCase() })
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

export async function pendingPenalties(db: Db): Promise<PendingPenalty[]> {
	const rows = await db
		.select({
			id: penalties.id,
			proposalId: penalties.proposalId,
			subSolver: penalties.subSolver,
			orderUid: penalties.orderUid,
		})
		.from(penalties)
		.where(sql`penalty_tx_hash IS NULL`)
		.orderBy(penalties.id);

	return rows.map((r) => ({
		id: r.id,
		proposalId: r.proposalId,
		subSolver: r.subSolver as Address,
		orderUid: r.orderUid,
	}));
}
