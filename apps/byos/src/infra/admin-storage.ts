import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { auditEvents, penalties, proposals } from "../db/schema.js";

export type TimeRange = "24h" | "7d" | "30d";

function rangeStart(range: TimeRange): Date {
	const now = new Date();
	switch (range) {
		case "24h":
			return new Date(now.getTime() - 24 * 60 * 60 * 1000);
		case "7d":
			return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
		case "30d":
			return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
	}
}

// --- Overview ---

export interface OverviewStats {
	proposalsReceived: number;
	rejectionBreakdown: { reason: string; count: number }[];
	settled: number;
	settleFailed: number;
	penalized: number;
	nonSettlementDebited: number;
	bufferDebited: number;
}

export async function getOverviewStats(db: Db, range: TimeRange): Promise<OverviewStats> {
	const since = rangeStart(range);

	const [received, rejections, settled, settleFailed, penalizedCount, nonSettlement, buffer] =
		await Promise.all([
			// total received
			db
				.select({ count: count() })
				.from(auditEvents)
				.where(and(eq(auditEvents.eventType, "received"), gte(auditEvents.occurredAt, since))),

			// rejection breakdown by reason (stored in payload->rejectionReason)
			db
				.select({
					reason: sql<string>`payload->>'rejectionReason'`,
					count: count(),
				})
				.from(auditEvents)
				.where(and(eq(auditEvents.eventType, "rejected"), gte(auditEvents.occurredAt, since)))
				.groupBy(sql`payload->>'rejectionReason'`),

			// settled
			db
				.select({ count: count() })
				.from(auditEvents)
				.where(and(eq(auditEvents.eventType, "settled"), gte(auditEvents.occurredAt, since))),

			// settle_failed
			db
				.select({ count: count() })
				.from(auditEvents)
				.where(and(eq(auditEvents.eventType, "settle_failed"), gte(auditEvents.occurredAt, since))),

			// penalized
			db
				.select({ count: count() })
				.from(auditEvents)
				.where(and(eq(auditEvents.eventType, "penalized"), gte(auditEvents.occurredAt, since))),

			// non_settlement_debited
			db
				.select({ count: count() })
				.from(auditEvents)
				.where(
					and(
						eq(auditEvents.eventType, "non_settlement_debited"),
						gte(auditEvents.occurredAt, since),
					),
				),

			// buffer_debited
			db
				.select({ count: count() })
				.from(auditEvents)
				.where(
					and(eq(auditEvents.eventType, "buffer_debited"), gte(auditEvents.occurredAt, since)),
				),
		]);

	return {
		proposalsReceived: received[0]?.count ?? 0,
		rejectionBreakdown: rejections.map((r) => ({
			reason: r.reason ?? "unknown",
			count: r.count,
		})),
		settled: settled[0]?.count ?? 0,
		settleFailed: settleFailed[0]?.count ?? 0,
		penalized: penalizedCount[0]?.count ?? 0,
		nonSettlementDebited: nonSettlement[0]?.count ?? 0,
		bufferDebited: buffer[0]?.count ?? 0,
	};
}

// --- Per-subsolver ---

export interface SubsolverStats {
	subSolver: string;
	proposalsReceived: number;
	settled: number;
	settleFailed: number;
	rejected: number;
	penalized: number;
}

export async function getSubsolverStats(db: Db, range: TimeRange): Promise<SubsolverStats[]> {
	const since = rangeStart(range);

	const rows = await db
		.select({
			subSolver: auditEvents.subSolver,
			eventType: auditEvents.eventType,
			count: count(),
		})
		.from(auditEvents)
		.where(gte(auditEvents.occurredAt, since))
		.groupBy(auditEvents.subSolver, auditEvents.eventType);

	// Pivot in memory — the table is small enough and avoids complex SQL
	const map = new Map<string, SubsolverStats>();
	for (const row of rows) {
		if (!map.has(row.subSolver)) {
			map.set(row.subSolver, {
				subSolver: row.subSolver,
				proposalsReceived: 0,
				settled: 0,
				settleFailed: 0,
				rejected: 0,
				penalized: 0,
			});
		}
		const entry = map.get(row.subSolver)!;
		switch (row.eventType) {
			case "received":
				entry.proposalsReceived = row.count;
				break;
			case "settled":
				entry.settled = row.count;
				break;
			case "settle_failed":
				entry.settleFailed = row.count;
				break;
			case "rejected":
				entry.rejected = row.count;
				break;
			case "penalized":
			case "non_settlement_debited":
				entry.penalized += row.count;
				break;
		}
	}

	return [...map.values()].sort((a, b) => b.proposalsReceived - a.proposalsReceived);
}

// --- Proposals list ---

export interface ProposalListItem {
	id: number;
	subSolver: string;
	orderUid: string;
	status: string;
	rejectionReason: string | null;
	createdAt: Date;
	statusChangedAt: Date;
}

export interface ProposalListOptions {
	subSolver?: string;
	status?: string;
	page: number;
	limit: number;
}

export async function listProposals(
	db: Db,
	opts: ProposalListOptions,
): Promise<{ items: ProposalListItem[]; total: number }> {
	const { subSolver, status, page, limit } = opts;
	const offset = (page - 1) * limit;

	const conditions = [];
	if (subSolver) conditions.push(eq(proposals.subSolver, subSolver.toLowerCase()));
	if (status) conditions.push(eq(proposals.status, status));

	const where = conditions.length > 0 ? and(...conditions) : undefined;

	const [items, totalRows] = await Promise.all([
		db
			.select({
				id: proposals.id,
				subSolver: proposals.subSolver,
				orderUid: proposals.orderUid,
				status: proposals.status,
				rejectionReason: proposals.rejectionReason,
				createdAt: proposals.createdAt,
				statusChangedAt: proposals.statusChangedAt,
			})
			.from(proposals)
			.where(where)
			.orderBy(desc(proposals.createdAt))
			.limit(limit)
			.offset(offset),

		db.select({ count: count() }).from(proposals).where(where),
	]);

	return { items, total: totalRows[0]?.count ?? 0 };
}

// --- Proposal audit trail ---

export interface AuditEventRow {
	id: number;
	eventType: string;
	payload: unknown;
	occurredAt: Date;
	recordedAt: Date;
}

export interface ProposalDetail {
	proposal: ProposalListItem & {
		sellToken: string;
		buyToken: string;
		sellAmount: string;
		minBuyAmount: string;
		settlementTxHash: string | null;
		penaltyTxHash: string | null;
	};
	auditTrail: AuditEventRow[];
}

export async function getProposalDetail(db: Db, id: number): Promise<ProposalDetail | null> {
	const [proposal] = await db
		.select({
			id: proposals.id,
			subSolver: proposals.subSolver,
			orderUid: proposals.orderUid,
			status: proposals.status,
			rejectionReason: proposals.rejectionReason,
			createdAt: proposals.createdAt,
			statusChangedAt: proposals.statusChangedAt,
			sellToken: proposals.sellToken,
			buyToken: proposals.buyToken,
			sellAmount: proposals.sellAmount,
			minBuyAmount: proposals.minBuyAmount,
			settlementTxHash: proposals.settlementTxHash,
			penaltyTxHash: proposals.penaltyTxHash,
		})
		.from(proposals)
		.where(eq(proposals.id, id));

	if (!proposal) return null;

	const trail = await db
		.select({
			id: auditEvents.id,
			eventType: auditEvents.eventType,
			payload: auditEvents.payload,
			occurredAt: auditEvents.occurredAt,
			recordedAt: auditEvents.recordedAt,
		})
		.from(auditEvents)
		.where(eq(auditEvents.proposalId, id))
		.orderBy(auditEvents.occurredAt);

	return { proposal, auditTrail: trail };
}

// --- Pending penalties ---

export async function getPendingPenaltiesCount(db: Db): Promise<number> {
	const [row] = await db
		.select({ count: count() })
		.from(penalties)
		.where(sql`penalty_tx_hash IS NULL`);
	return row?.count ?? 0;
}
