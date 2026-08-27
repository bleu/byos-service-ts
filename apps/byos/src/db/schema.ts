import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	index,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

// --- service state ---

/**
 * Singleton state shared by every active BYOS replica.  The primary key
 * deliberately fixes the table to one row rather than relying on callers to
 * agree on a magic key.
 */
export const serviceState = pgTable("service_state", {
	id: boolean().primaryKey().default(true),
	latestAuctionGasPrice: text("latest_auction_gas_price"),
	latestAuctionGasPriceAt: timestamp("latest_auction_gas_price_at", { withTimezone: true }),
});

// --- debit operations ---

export const debitOperations = pgTable(
	"debit_operations",
	{
		id: bigserial({ mode: "number" }).primaryKey(),
		sourceKind: text("source_kind").notNull(),
		sourceId: text("source_id").notNull(),
		subSolver: text("sub_solver").notNull(),
		amount: text().notNull(),
		reason: text().notNull(),
		status: text().notNull().default("ready"),
		leaseOwner: text("lease_owner"),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		attemptCount: bigint("attempt_count", { mode: "number" }).notNull().default(0),
		lastError: text("last_error"),
		nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
		rawTransaction: text("raw_transaction"),
		transactionHash: text("transaction_hash"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [uniqueIndex("debit_operations_source_idx").on(table.sourceKind, table.sourceId)],
);

// --- proposals ---

export const proposals = pgTable(
	"proposals",
	{
		id: bigserial({ mode: "number" }).primaryKey(),
		subSolver: text("sub_solver").notNull(),
		orderUid: text("order_uid").notNull(),
		orderUidHash: text("order_uid_hash").notNull(),
		sellAmount: text("sell_amount").notNull(),
		minBuyAmount: text("min_buy_amount").notNull(),
		quoteBuyAmount: text("quote_buy_amount").notNull(),
		sellToken: text("sell_token").notNull(),
		buyToken: text("buy_token").notNull(),
		interactions: jsonb().notNull(),
		interactionsHash: text("interactions_hash").notNull(),
		validUntil: text("valid_until").notNull(),
		nonce: text().notNull(),
		signature: text().notNull(),
		status: text().notNull(),
		rejectionReason: text("rejection_reason"),
		gasUsed: bigint("gas_used", { mode: "number" }),
		trampoline: text(),
		settlementTxHash: text("settlement_tx_hash"),
		penaltyTxHash: text("penalty_tx_hash"),
		pendingCancellation: boolean("pending_cancellation").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("proposals_order_uid_status_idx").on(table.orderUid, table.status),
		index("proposals_sub_solver_status_idx").on(table.subSolver, table.status),
		index("proposals_status_status_changed_at_idx").on(table.status, table.statusChangedAt),
	],
);

// --- audit_events ---

export const auditEvents = pgTable(
	"audit_events",
	{
		id: bigserial({ mode: "number" }).primaryKey(),
		proposalId: bigint("proposal_id", { mode: "number" }).notNull(),
		eventType: text("event_type").notNull(),
		subSolver: text("sub_solver").notNull(),
		orderUid: text("order_uid").notNull(),
		settlementTxHash: text("settlement_tx_hash"),
		payload: jsonb().notNull(),
		occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
		recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("audit_events_proposal_id_idx").on(table.proposalId),
		index("audit_events_order_uid_idx").on(table.orderUid),
		index("audit_events_sub_solver_idx").on(table.subSolver),
		index("audit_events_settlement_tx_hash_idx")
			.on(table.settlementTxHash)
			.where(sql`settlement_tx_hash IS NOT NULL`),
	],
);

// --- solutions ---

export const solutions = pgTable(
	"solutions",
	{
		auctionId: bigint("auction_id", { mode: "number" }).notNull(),
		solutionId: bigint("solution_id", { mode: "number" }).notNull(),
		proposalId: bigint("proposal_id", { mode: "number" })
			.notNull()
			.references(() => proposals.id, { onDelete: "cascade" }),
		buyTokenRefPrice: text("buy_token_ref_price").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		primaryKey({ columns: [table.auctionId, table.solutionId] }),
		index("solutions_proposal_id_idx").on(table.proposalId),
	],
);

// --- buffer_entries ---
// Per-proposal ledger for the quoteBuyAmount-vs-delivered gap. Positive native_token_amount
// means under-delivery (debit); negative means over-delivery (credit).
// Debits are slashed automatically when the outstanding balance exceeds c_L.
// Credits offset future shortfalls but are never paid out.

export const bufferEntries = pgTable(
	"buffer_entries",
	{
		id: bigserial({ mode: "number" }).primaryKey(),
		subSolver: text("sub_solver").notNull(),
		proposalId: bigint("proposal_id", { mode: "number" })
			.notNull()
			.references(() => proposals.id, { onDelete: "cascade" }),
		orderUid: text("order_uid").notNull(),
		delta: text().notNull(),
		gap: text().notNull(),
		buyToken: text("buy_token").notNull(),
		nativeTokenAmount: text("native_token_amount").notNull(),
		cleared: boolean().notNull().default(false),
		clearTxHash: text("clear_tx_hash"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("buffer_entries_sub_solver_cleared_idx").on(table.subSolver, table.cleared),
		index("buffer_entries_proposal_id_idx").on(table.proposalId),
	],
);

// --- penalties ---

export const penalties = pgTable(
	"penalties",
	{
		id: bigserial({ mode: "number" }).primaryKey(),
		proposalId: bigint("proposal_id", { mode: "number" }).notNull(),
		subSolver: text("sub_solver").notNull(),
		orderUid: text("order_uid").notNull(),
		penaltyTxHash: text("penalty_tx_hash"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [index("penalties_pending_idx").on(table.id).where(sql`penalty_tx_hash IS NULL`)],
);
