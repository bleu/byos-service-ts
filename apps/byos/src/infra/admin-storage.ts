import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { auditEvents, penalties, proposals } from "../db/schema.js";

export interface DateRange {
	from: Date;
	to: Date;
}

// --- Overview ---

export interface OverviewStats {
	// Funnel
	received: number;
	discarded: number;
	simFailed: number;
	sentToAuction: number;
	won: number;
	lost: number;
	settled: number;
	settleFailed: number;
	// Breakdown
	rejectionBreakdown: { reason: string; count: number }[];
	// Penalties & debits
	penalizedCount: number;
	penalizedAmountWei: string;
	nonSettlementDebitedCount: number;
	bufferDebitedCount: number;
}

export async function getOverviewStats(db: Db, range: DateRange): Promise<OverviewStats> {
	const { from, to } = range;

	const inRange = (type: string) =>
		and(eq(auditEvents.eventType, type), gte(auditEvents.occurredAt, from), lt(auditEvents.occurredAt, to));

	const countOf = (type: string) =>
		db.select({ count: count() }).from(auditEvents).where(inRange(type));

	const [received, simFailed, rejections, settled, settleFailed, penalized, nonSettlementDebited, bufferDebited] =
		await Promise.all([
			countOf("received"),
			countOf("sim_failed"),
			db
				.select({
					reason: sql<string>`payload->>'rejectionReason'`,
					count: count(),
				})
				.from(auditEvents)
				.where(inRange("rejected"))
				.groupBy(sql`payload->>'rejectionReason'`),
			countOf("settled"),
			countOf("settle_failed"),
			db
				.select({
					count: count(),
					amount: sql<string>`COALESCE(SUM((payload->>'amount')::numeric), 0)::text`,
				})
				.from(auditEvents)
				.where(inRange("penalized")),
			countOf("non_settlement_debited"),
			countOf("buffer_debited"),
		]);

	const receivedCount = received[0]?.count ?? 0;
	const simFailedCount = simFailed[0]?.count ?? 0;
	const rejectedCount = rejections.reduce((acc, r) => acc + r.count, 0);
	const discarded = simFailedCount + rejectedCount;
	const sentToAuction = receivedCount - discarded;
	const settledCount = settled[0]?.count ?? 0;
	const settleFailedCount = settleFailed[0]?.count ?? 0;
	const won = settledCount + settleFailedCount;
	const lost = Math.max(0, sentToAuction - won);

	return {
		received: receivedCount,
		discarded,
		simFailed: simFailedCount,
		sentToAuction,
		won,
		lost,
		settled: settledCount,
		settleFailed: settleFailedCount,
		rejectionBreakdown: rejections.map((r) => ({
			reason: r.reason ?? "unknown",
			count: r.count,
		})),
		penalizedCount: penalized[0]?.count ?? 0,
		penalizedAmountWei: penalized[0]?.amount ?? "0",
		nonSettlementDebitedCount: nonSettlementDebited[0]?.count ?? 0,
		bufferDebitedCount: bufferDebited[0]?.count ?? 0,
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

export async function getSubsolverStats(db: Db, range: DateRange): Promise<SubsolverStats[]> {
	const { from, to } = range;

	const rows = await db
		.select({
			subSolver: auditEvents.subSolver,
			eventType: auditEvents.eventType,
			count: count(),
		})
		.from(auditEvents)
		.where(and(gte(auditEvents.occurredAt, from), lt(auditEvents.occurredAt, to)))
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
	settlementTxHash: string | null;
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
				settlementTxHash: proposals.settlementTxHash,
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
