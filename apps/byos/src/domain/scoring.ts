import type { Address } from "viem";

/** Conservative gas floor for escrow threshold calculations. */
export const ESCROW_GAS_ESTIMATION = 200_000n;

/** Buffer added to simulated gas for scoring. */
export const GAS_BUFFER = 30_000n;

const ETHER = 10n ** 18n;

/** Effective gas for a simulated proposal: simulated gas + safety buffer. */
export function effectiveGas(simulated: bigint): bigint {
	return simulated + GAS_BUFFER;
}

/**
 * The token surplus is denominated in: the buy token for a sell order,
 * the sell token for a buy order.
 */
export function surplusToken(isSellOrder: boolean, sellToken: Address, buyToken: Address): Address {
	return isSellOrder ? buyToken : sellToken;
}

/** A proposal weighed against its order at this auction's gas price. */
export interface Candidate {
	orderSell: bigint;
	orderBuy: bigint;
	proposalSell: bigint;
	proposalBuy: bigint;
	isSellOrder: boolean;
	/** Gas cost in wei: effective_gas(gas_used) × effective_gas_price */
	gasCost: bigint;
}

function ceilDiv(a: bigint, b: bigint): bigint {
	return (a + b - 1n) / b;
}

/**
 * Scales order limits to the proposal's fill fraction for partially fillable
 * orders. For fill-or-kill orders the candidate passes through unchanged.
 * Returns null on arithmetic issues (zero divisor, overflow not applicable in JS bigint).
 */
export function scaledToFill(candidate: Candidate, partiallyFillable: boolean): Candidate | null {
	if (!partiallyFillable) {
		return candidate;
	}
	if (candidate.isSellOrder) {
		if (candidate.orderSell === 0n) {
			return null;
		}
		const scaledBuy = ceilDiv(candidate.orderBuy * candidate.proposalSell, candidate.orderSell);
		return {
			...candidate,
			orderSell: candidate.proposalSell,
			orderBuy: scaledBuy,
		};
	}
	if (candidate.orderBuy === 0n) {
		return null;
	}
	const scaledSell = (candidate.orderSell * candidate.proposalBuy) / candidate.orderBuy;
	return {
		...candidate,
		orderSell: scaledSell,
		orderBuy: candidate.proposalBuy,
	};
}

/**
 * Score a proposal against an order. Returns null when the proposal is
 * below the order's limit or when gas exceeds the surplus.
 *
 * Surplus is the improvement over the order's limit:
 *  - Sell order: proposal_buy - order_buy (more buy tokens for the user)
 *  - Buy order: order_sell - proposal_sell (fewer sell tokens from the user)
 */
export function scoreProposal(candidate: Candidate, surplusPrice: bigint): bigint | null {
	const surplus = candidate.isSellOrder
		? candidate.proposalBuy - candidate.orderBuy
		: candidate.orderSell - candidate.proposalSell;

	if (surplus < 0n) {
		return null;
	}

	const surplusEth = (surplus * surplusPrice) / ETHER;
	const score = surplusEth - candidate.gasCost;

	if (score < 0n) {
		return null;
	}

	return score;
}
