import type { Logger } from "pino";
import type { Proposal } from "../domain/proposal.js";

/** viem's full error message can contain credential-bearing URLs and request bodies. */
function errorSummary(error: unknown, depth = 0): unknown {
	if (typeof error !== "object" || error === null) {
		return typeof error === "string" ? redactUrls(error) : String(error);
	}
	const e = error as Record<string, unknown>;
	const message = typeof e.shortMessage === "string" ? e.shortMessage : e.message;
	return {
		name: typeof e.name === "string" ? e.name : undefined,
		message: typeof message === "string" ? redactUrls(message) : undefined,
		code: typeof e.code === "number" ? e.code : undefined,
		status: typeof e.status === "number" ? e.status : undefined,
		details: typeof e.details === "string" ? redactUrls(e.details) : undefined,
		cause: e.cause !== undefined && depth < 4 ? errorSummary(e.cause, depth + 1) : undefined,
	};
}

function redactUrls(message: string): string {
	return message.replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted RPC URL]");
}

export function logValidationUnavailable(
	logger: Logger | undefined,
	proposal: Pick<Proposal, "id" | "auctionId" | "orderUid" | "subSolver">,
	stage: string,
	err?: unknown,
): void {
	logger?.warn(
		{
			proposalId: proposal.id,
			auctionId: proposal.auctionId,
			orderUid: proposal.orderUid,
			subSolver: proposal.subSolver,
			stage,
			error: err === undefined ? undefined : errorSummary(err),
		},
		"proposal validation unavailable",
	);
}
