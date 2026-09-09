import { and, count, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "./db";
import { auditEvents, bufferEntries, penalties, proposals } from "./schema";

export interface DateRange {
	from: Date;
	to: Date;
}

// --- Overview ---

export interface OverviewStats {
	// Funnel (proposals created in range, by current status — always coherent)
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
	// Penalties & debits (event-time: financial events that occurred in range)
	penalizedCount: number;
	penalizedAmountWei: string;
	nonSettlementDebitedCount: number;
	bufferDebitedCount: number;
}

export async function getOverviewStats(db: Db, range: DateRange): Promise<OverviewStats> {
	const { from, to } = range;

	const [statusRows, rejectionRows, [penaltyStats]] = await Promise.all([
		db
			.select({ status: proposals.status, count: count() })
			.from(proposals)
			.where(and(gte(proposals.createdAt, from), lt(proposals.createdAt, to)))
			.groupBy(proposals.status),

		db
			.select({ reason: proposals.rejectionReason, count: count() })
			.from(proposals)
			.where(
				and(
					gte(proposals.createdAt, from),
					lt(proposals.createdAt, to),
					isNotNull(proposals.rejectionReason),
				),
			)
			.groupBy(proposals.rejectionReason),

		db
			.select({
				penalizedCount: sql<number>`COUNT(*) FILTER (WHERE event_type = 'penalized')`,
				penalizedAmount: sql<string>`COALESCE(SUM((payload->>'amount')::numeric) FILTER (WHERE event_type = 'penalized'), 0)::text`,
				nonSettlementDebitedCount: sql<number>`COUNT(*) FILTER (WHERE event_type = 'non_settlement_debited')`,
				bufferDebitedCount: sql<number>`COUNT(*) FILTER (WHERE event_type = 'buffer_debited')`,
			})
			.from(auditEvents)
			.where(and(gte(auditEvents.occurredAt, from), lt(auditEvents.occurredAt, to))),
	]);

	const byStatus = new Map(statusRows.map((r) => [r.status, r.count]));
	const simFailedCount = byStatus.get("simFailed") ?? 0;
	const rejectedCount = byStatus.get("rejected") ?? 0;
	const settledCount = byStatus.get("settled") ?? 0;
	const settleFailedCount = byStatus.get("settleFailed") ?? 0;
	const received = statusRows.reduce((acc, r) => acc + r.count, 0);
	const discarded = simFailedCount + rejectedCount;
	const sentToAuction = received - discarded;
	const won = settledCount + settleFailedCount;
	const lost = sentToAuction - won;

	return {
		received,
		discarded,
		simFailed: simFailedCount,
		sentToAuction,
		won,
		lost,
		settled: settledCount,
		settleFailed: settleFailedCount,
		rejectionBreakdown: rejectionRows.map((r) => ({
			reason: r.reason ?? "unknown",
			count: r.count,
		})),
		penalizedCount: Number(penaltyStats?.penalizedCount ?? 0),
		penalizedAmountWei: penaltyStats?.penalizedAmount ?? "0",
		nonSettlementDebitedCount: Number(penaltyStats?.nonSettlementDebitedCount ?? 0),
		bufferDebitedCount: Number(penaltyStats?.bufferDebitedCount ?? 0),
	};
}

// --- Per-subsolver ---

export interface SubsolverStats {
	subSolver: string;
	// Activity columns — filtered by date range
	proposalsReceived: number;
	settled: number;
	settleFailed: number;
	rejected: number;
	penalized: number;
	// Lifetime financial columns
	penaltyCount: number;
	penalizedAmountWei: string;
	bufferBalanceWei: string;
}

export async function getSubsolverStats(db: Db, range: DateRange): Promise<SubsolverStats[]> {
	const { from, to } = range;

	const fromIso = from.toISOString();
	const toIso = to.toISOString();

	// All subsolvers ever seen, with activity counts filtered to the date range.
	const activityRows = await db
		.select({
			subSolver: auditEvents.subSolver,
			proposalsReceived: sql<number>`COUNT(*) FILTER (WHERE event_type = 'received' AND occurred_at >= ${fromIso}::timestamptz AND occurred_at < ${toIso}::timestamptz)`,
			settled: sql<number>`COUNT(*) FILTER (WHERE event_type = 'settled' AND occurred_at >= ${fromIso}::timestamptz AND occurred_at < ${toIso}::timestamptz)`,
			settleFailed: sql<number>`COUNT(*) FILTER (WHERE event_type = 'settle_failed' AND occurred_at >= ${fromIso}::timestamptz AND occurred_at < ${toIso}::timestamptz)`,
			rejected: sql<number>`COUNT(*) FILTER (WHERE event_type = 'rejected' AND occurred_at >= ${fromIso}::timestamptz AND occurred_at < ${toIso}::timestamptz)`,
			penalized: sql<number>`COUNT(*) FILTER (WHERE event_type IN ('penalized', 'non_settlement_debited') AND occurred_at >= ${fromIso}::timestamptz AND occurred_at < ${toIso}::timestamptz)`,
		})
		.from(auditEvents)
		.groupBy(auditEvents.subSolver);

	// Lifetime penalty totals per subsolver.
	const penaltyRows = await db
		.select({
			subSolver: penalties.subSolver,
			penaltyCount: sql<number>`COUNT(*)`,
			penalizedAmountWei: sql<string>`COALESCE(SUM((${auditEvents.payload}->>'amount')::numeric), 0)::text`,
		})
		.from(penalties)
		.leftJoin(
			auditEvents,
			and(eq(auditEvents.proposalId, penalties.proposalId), eq(auditEvents.eventType, "penalized")),
		)
		.groupBy(penalties.subSolver);

	// Lifetime uncleared buffer balance per subsolver.
	const bufferRows = await db
		.select({
			subSolver: bufferEntries.subSolver,
			bufferBalanceWei: sql<string>`COALESCE(SUM(CAST(${bufferEntries.nativeTokenAmount} AS numeric)), 0)::text`,
		})
		.from(bufferEntries)
		.where(eq(bufferEntries.cleared, false))
		.groupBy(bufferEntries.subSolver);

	const penaltyBySubsolver = new Map(penaltyRows.map((r) => [r.subSolver, r]));
	const bufferBySubsolver = new Map(bufferRows.map((r) => [r.subSolver, r]));

	return activityRows
		.map((r) => {
			const p = penaltyBySubsolver.get(r.subSolver);
			const b = bufferBySubsolver.get(r.subSolver);
			return {
				subSolver: r.subSolver,
				proposalsReceived: Number(r.proposalsReceived),
				settled: Number(r.settled),
				settleFailed: Number(r.settleFailed),
				rejected: Number(r.rejected),
				penalized: Number(r.penalized),
				penaltyCount: Number(p?.penaltyCount ?? 0),
				penalizedAmountWei: p?.penalizedAmountWei ?? "0",
				bufferBalanceWei: b?.bufferBalanceWei ?? "0",
			};
		})
		.sort((a, b) => b.proposalsReceived - a.proposalsReceived);
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

// --- Proposal detail ---

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
		.where(isNull(penalties.penaltyTxHash));
	return row?.count ?? 0;
}
