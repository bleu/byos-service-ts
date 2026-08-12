/** Machine-readable error kind. PascalCase on the wire. */
export const Kind = {
	InvalidSignature: "InvalidSignature",
	SignatureRecoveryFailed: "SignatureRecoveryFailed",
	InsufficientEscrow: "InsufficientEscrow",
	ProposalExpired: "ProposalExpired",
	ProposalLifetimeExceeded: "ProposalLifetimeExceeded",
	ProposalNotFound: "ProposalNotFound",
	ProposalNotCancellable: "ProposalNotCancellable",
	BadRequest: "BadRequest",
	Internal: "Internal",
} as const;

export type Kind = (typeof Kind)[keyof typeof Kind];

/** JSON error body served on every non-2xx response. */
export interface ApiError {
	kind: Kind;
	description: string;
}
