/** Machine-readable error kind. PascalCase on the wire. */
export const Kind = {
	InvalidSignature: "InvalidSignature",
	SignatureRecoveryFailed: "SignatureRecoveryFailed",
	/** Returned when a proposal carries `subSolverAddress` (EIP-1271 path) but
	 * the service is not configured with a `verifyEip1271` function. 503 so
	 * clients retry rather than treating this as a permanent rejection. */
	Eip1271NotAvailable: "Eip1271NotAvailable",
	InsufficientEscrow: "InsufficientEscrow",
	ProposalExpired: "ProposalExpired",
	ProposalLifetimeExceeded: "ProposalLifetimeExceeded",
	ProposalNotFound: "ProposalNotFound",
	ProposalNotCancellable: "ProposalNotCancellable",
	NonceAlreadyUsed: "NonceAlreadyUsed",
	SubsolverNotAllowed: "SubsolverNotAllowed",
	BadRequest: "BadRequest",
	RateLimited: "RateLimited",
	ServiceUnavailable: "ServiceUnavailable",
	Internal: "Internal",
} as const;

export type Kind = (typeof Kind)[keyof typeof Kind];

/** JSON error body served on every non-2xx response. */
export interface ApiError {
	kind: Kind;
	description: string;
}
