import { z } from "zod";

// --- Wire grammar ---
// Mirrors the Rust edge parsers (byos dto.rs): amounts are decimal strings —
// hex must not silently read as a number (ADR-0005) — and byte strings are
// hex with an optional 0x prefix and an even digit count. An empty amount
// reads as zero, an upstream ruint behaviour the Rust tests pin.

const U256_MAX = 2n ** 256n - 1n;

export const u256String = z
	.string()
	.regex(/^\d*$/, "expected a decimal string")
	// zod v3 still runs refinements when the regex failed, so guard again
	// before BigInt, which throws on non-decimal input.
	.refine((s) => !/^\d*$/.test(s) || BigInt(s || "0") <= U256_MAX, "value past U256 maximum");

export const hexString = z
	.string()
	.regex(/^(0x)?([0-9a-fA-F]{2})*$/, "expected an even number of hex digits");

// --- Interaction ---

export const interactionSchema = z.object({
	target: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
	value: u256String,
	callData: hexString,
});

export type DtoInteraction = z.infer<typeof interactionSchema>;

// --- Create Proposal ---

export const createProposalRequestSchema = z.object({
	orderUid: z.string().regex(/^(0x)?[0-9a-fA-F]{112}$/, "expected 56 hex bytes"),
	sellAmount: u256String,
	minBuyAmount: u256String,
	quoteBuyAmount: u256String,
	interactions: z.array(interactionSchema),
	validUntil: u256String,
	nonce: u256String,
	signature: hexString,
});

export type CreateProposalRequest = z.infer<typeof createProposalRequestSchema>;

export const createProposalResponseSchema = z.object({
	id: z.number(),
});

export type CreateProposalResponse = z.infer<typeof createProposalResponseSchema>;

// --- Status ---

export const Status = {
	Submitted: "submitted",
	Active: "active",
	Rejected: "rejected",
	Expired: "expired",
	Executing: "executing",
	Settled: "settled",
	SettleFailed: "settleFailed",
	Penalized: "penalized",
	SimFailed: "simFailed",
	Cancelled: "cancelled",
} as const;

export type Status = (typeof Status)[keyof typeof Status];

export const statusSchema = z.enum([
	Status.Submitted,
	Status.Active,
	Status.Rejected,
	Status.Expired,
	Status.Executing,
	Status.Settled,
	Status.SettleFailed,
	Status.Penalized,
	Status.SimFailed,
	Status.Cancelled,
]);

/**
 * Whether the proposal can never become executable again.
 * Executing is deliberately absent: a settlement in flight can be released back to Active.
 */
export function isTerminalStatus(status: Status): boolean {
	switch (status) {
		case Status.Rejected:
		case Status.Expired:
		case Status.Settled:
		case Status.SettleFailed:
		case Status.Penalized:
		case Status.SimFailed:
		case Status.Cancelled:
			return true;
		default:
			return false;
	}
}

// --- Rejection Reason ---

export const RejectionReason = {
	InsufficientEscrow: "InsufficientEscrow",
	UnsupportedOrder: "UnsupportedOrder",
	AmountMismatch: "AmountMismatch",
	OrderNotFound: "OrderNotFound",
	Unprofitable: "Unprofitable",
} as const;

export type RejectionReason = (typeof RejectionReason)[keyof typeof RejectionReason];

export const rejectionReasonSchema = z.enum([
	RejectionReason.InsufficientEscrow,
	RejectionReason.UnsupportedOrder,
	RejectionReason.AmountMismatch,
	RejectionReason.OrderNotFound,
	RejectionReason.Unprofitable,
]);

// --- Proposal Metadata ---

export const proposalMetadataSchema = z.object({
	id: z.number(),
	subSolver: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
	validUntil: z.string(),
	status: statusSchema,
});

export type ProposalMetadata = z.infer<typeof proposalMetadataSchema>;

// --- Get Proposal Response ---

export const getProposalResponseSchema = z.object({
	id: z.number(),
	subSolver: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
	orderUid: z.string(),
	sellAmount: z.string(),
	minBuyAmount: z.string(),
	quoteBuyAmount: z.string(),
	validUntil: z.string(),
	status: statusSchema,
	rejectionReason: rejectionReasonSchema.optional(),
	settlementTxHash: z.string().optional(),
	penaltyTxHash: z.string().optional(),
});

export type GetProposalResponse = z.infer<typeof getProposalResponseSchema>;

// --- List Proposals Response ---

export const listProposalsResponseSchema = z.object({
	proposals: z.array(proposalMetadataSchema),
});

export type ListProposalsResponse = z.infer<typeof listProposalsResponseSchema>;
