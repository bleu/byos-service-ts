import type { Candidate } from "./scoring.js";

const ETHER = 10n ** 18n;

function ceilDiv(a: bigint, b: bigint): bigint {
	return (a + b - 1n) / b;
}

/** A proposal's gas cut, sized against one order. */
export interface GasCut {
	/** The cut itself, in sell-token atoms. */
	amount: bigint;
	/** The fulfillment's executed_amount. */
	executedAmount: bigint;
}

/**
 * Size the cut for one proposal and shape the fulfillment amounts around it.
 *
 * Returns null when the sell token has no price, or when taking the cut would
 * push the user past the limit they signed.
 */
export function gasCutSize(candidate: Candidate, sellTokenPrice: bigint): GasCut | null {
	if (sellTokenPrice === 0n) {
		return null;
	}

	// Round up: a cut an atom short of the gas bill is a loss
	const amount = ceilDiv(candidate.gasCost * ETHER, sellTokenPrice);

	if (candidate.isSellOrder) {
		const executed = candidate.orderSell - amount;
		if (executed < 0n) {
			return null;
		}
		// Declaring only `executed` of the full sell amount scales what the user receives
		if (candidate.proposalSell === 0n) {
			return null;
		}
		const received = (candidate.proposalBuy * executed) / candidate.proposalSell;
		if (received < candidate.orderBuy) {
			return null;
		}
		return { amount, executedAmount: executed };
	}

	// Buy order: route's input plus the cut is what leaves the user's wallet
	if (candidate.proposalSell + amount > candidate.orderSell) {
		return null;
	}
	return { amount, executedAmount: candidate.orderBuy };
}
