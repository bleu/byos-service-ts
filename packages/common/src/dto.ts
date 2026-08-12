import { z } from "zod";

// --- Interaction ---

export const interactionSchema = z.object({
	target: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
	value: z.string(),
	callData: z.string(),
});

export type DtoInteraction = z.infer<typeof interactionSchema>;

// --- Create Proposal ---

export const createProposalRequestSchema = z.object({
	orderUid: z.string(),
	sellAmount: z.string(),
	buyAmount: z.string(),
	interactions: z.array(interactionSchema),
	validUntil: z.string(),
	nonce: z.string(),
	signature: z.string(),
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
	buyAmount: z.string(),
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
