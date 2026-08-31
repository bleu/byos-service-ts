import type { Address, Hex } from "viem";

/** The chain edge the penalty loop drives — Rust's DebitEscrow trait. */
export interface DebitEscrow {
	settlementCost(txHash: Hex): Promise<bigint>;
	/** Sign without broadcasting. The worker durably records these exact bytes first. */
	signDebit: (
		subSolver: Address,
		amount: bigint,
		reason: Hex,
	) => Promise<{ rawTransaction: Hex; hash: Hex }>;
	/** Broadcast previously persisted bytes; callers must never construct a replacement transaction. */
	broadcastSignedDebit: (rawTransaction: Hex) => Promise<Hex>;
	/** Returns null while the node cannot yet establish an outcome. */
	debitOutcome: (hash: Hex) => Promise<"succeeded" | "reverted" | null>;
	readExecutedDelta(txHash: Hex, orderUidHash: Hex): Promise<bigint>;
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

/**
 * Converts a buy-token gap to ETH using the auction reference price.
 *
 * The result feeds into the buffer ledger. Positive entries (under-delivery)
 * accumulate until the outstanding balance exceeds c_L, then the full balance
 * is debited from escrow. Negative entries (over-delivery) offset future
 * shortfalls but are never paid out.
 */
export function bufferDebit(gap: bigint, refPrice: bigint): bigint {
	return (gap * refPrice) / ETHER;
}

/** A queued penalty awaiting escrow debit. */
export interface PendingPenalty {
	id: number;
	proposalId: number;
	subSolver: Address;
	orderUid: string;
}
