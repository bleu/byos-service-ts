import type { Address, Hex } from "viem";

/** The chain edge the penalty loop drives — Rust's DebitEscrow trait. */
export interface DebitEscrow {
	settlementCost(txHash: Hex): Promise<bigint>;
	debit(subSolver: Address, amount: bigint, reason: Hex): Promise<Hex>;
	readExecutedDelta(txHash: Hex): Promise<bigint>;
}

/** Reverted settlement debit = settlement's on-chain cost + c_l. */
export function revertDebit(settlementCost: bigint, cL: bigint): bigint {
	return settlementCost + cL;
}

/** Non-settlement debit = 0.1 × c_l. */
export function nonSettlementDebit(cL: bigint): bigint {
	return cL / 10n;
}

const ETHER = 10n ** 18n;

/** Slippage debit: converts a buy-token gap to ETH using the auction reference price. */
export function slippageDebit(gap: bigint, refPrice: bigint): bigint {
	return (gap * refPrice) / ETHER;
}

/** A queued penalty awaiting escrow debit. */
export interface PendingPenalty {
	id: number;
	proposalId: number;
	subSolver: Address;
	orderUid: string;
}
