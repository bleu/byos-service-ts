import type { RejectionReason } from "@byos/common";
import type { Address } from "viem";
import type { Proposal } from "./proposal.js";

/** Results of a successful settlement simulation. */
export interface SimulationOutcome {
	gasUsed: bigint;
	trampoline: Address;
	sellToken: Address;
	buyToken: Address;
}

/** Outcome of validating a single proposal. */
export type Verdict =
	| { kind: "accept"; simulation: SimulationOutcome | null }
	| { kind: "reject"; reason: RejectionReason }
	| { kind: "simFailed" };

/** Validates a single proposal. Returns null to skip (retry next tick). */
export interface ValidateProposal {
	validate(proposal: Proposal): Promise<Verdict | null>;
}

/** Stub validator that accepts everything. Used for local dev and tests. */
export const acceptAll: ValidateProposal = {
	async validate(): Promise<Verdict> {
		return { kind: "accept", simulation: null };
	},
};
