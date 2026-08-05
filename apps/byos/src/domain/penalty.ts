import type { Address } from "viem";

/** Reverted settlement debit = settlement's on-chain cost + c_l. */
export function revertDebit(settlementCost: bigint, cL: bigint): bigint {
	return settlementCost + cL;
}

/** Non-settlement debit = 0.1 × c_l. */
export function nonSettlementDebit(cL: bigint): bigint {
	return cL / 10n;
}

/** A queued penalty awaiting escrow debit. */
export interface PendingPenalty {
	id: number;
	proposalId: number;
	subSolver: Address;
	orderUid: string;
}
