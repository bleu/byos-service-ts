import { Kind } from "@byos/common";
import type { Context } from "hono";

export { Kind } from "@byos/common";

const STATUS_MAP: Record<string, number> = {
	[Kind.InvalidSignature]: 400,
	[Kind.SignatureRecoveryFailed]: 400,
	[Kind.BadRequest]: 400,
	[Kind.ProposalExpired]: 400,
	[Kind.ProposalLifetimeExceeded]: 400,
	[Kind.InsufficientEscrow]: 403,
	[Kind.ProposalNotFound]: 404,
	[Kind.ProposalNotCancellable]: 409,
	[Kind.NonceAlreadyUsed]: 409,
	[Kind.RateLimited]: 429,
	[Kind.Internal]: 500,
	[Kind.ServiceUnavailable]: 503,
};

/** Default descriptions per kind, as served by the Rust error type. */
const DEFAULT_DESCRIPTIONS: Record<string, string> = {
	[Kind.InvalidSignature]: "Invalid EIP-712 signature",
	[Kind.SignatureRecoveryFailed]: "Could not recover signer from signature",
	[Kind.InsufficientEscrow]: "Sub-solver escrow balance below minimum",
	[Kind.ProposalExpired]: "Proposal validUntil is in the past",
	[Kind.ProposalLifetimeExceeded]: "Proposal validUntil exceeds the maximum proposal lifetime",
	[Kind.ProposalNotFound]: "Proposal not found",
	[Kind.ProposalNotCancellable]: "Proposal is executing or already in a terminal state",
	[Kind.NonceAlreadyUsed]: "Nonce has already been used with different signed proposal content",
	[Kind.BadRequest]: "Malformed request",
	[Kind.RateLimited]: "Rate limit exceeded",
	[Kind.Internal]: "Internal error",
	[Kind.ServiceUnavailable]: "Service temporarily unavailable",
};

export class AppError extends Error {
	readonly kind: string;
	readonly statusCode: number;
	/** Seconds to wait before retrying, served as Retry-After. Set on the
	 * shed-load kinds (429, 503); absent everywhere else. */
	readonly retryAfterSecs?: number;

	constructor(kind: string, description?: string, retryAfterSecs?: number) {
		super(description ?? DEFAULT_DESCRIPTIONS[kind] ?? kind);
		this.kind = kind;
		this.statusCode = STATUS_MAP[kind] ?? 500;
		this.retryAfterSecs = retryAfterSecs;
	}
}

/** Hono error handler: converts AppError → JSON { kind, description }. */
export function errorHandler(err: Error, c: Context): Response {
	if (err instanceof AppError) {
		if (err.retryAfterSecs !== undefined) {
			c.header("Retry-After", String(err.retryAfterSecs));
		}
		return c.json({ kind: err.kind, description: err.message }, err.statusCode as 400);
	}
	return c.json({ kind: Kind.Internal, description: "Internal error" }, 500);
}
