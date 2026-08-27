import type { Address } from "viem";
import type { CandidateOrder } from "./provider.js";

export interface PollOrder {
	uid: string;
	chainId: number;
	sellToken: Address;
	buyToken: Address;
	/** Original signed sell amount. */
	fullSellAmount: bigint;
	/** Original signed buy floor. */
	fullBuyAmount: bigint;
	/** Amount already executed, in sell-token units for a sell order. */
	executedSellAmount: bigint;
	/** Auction-estimated native-token surplus, used only for quote ordering. */
	estimatedNativeSurplus?: bigint;
}

export interface RankedCandidate {
	candidate: CandidateOrder;
	estimatedNativeSurplus: bigint;
	needsSubmission: boolean;
}

/** Ceiling division for positive integers. */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
	if (denominator <= 0n) throw new Error("ceilDiv denominator must be positive");
	return (numerator + denominator - 1n) / denominator;
}

/**
 * Converts a sell order into the amount Fynd must route now. The protected
 * buy floor scales proportionally and rounds up, preserving the order limit.
 */
export function toCandidateOrder(order: PollOrder): CandidateOrder | null {
	if (order.fullSellAmount <= 0n || order.executedSellAmount < 0n) return null;
	const remainingSell = order.fullSellAmount - order.executedSellAmount;
	if (remainingSell <= 0n) return null;
	return {
		uid: order.uid,
		chainId: order.chainId,
		sellToken: order.sellToken,
		buyToken: order.buyToken,
		remainingSell,
		scaledLimitBuy: ceilDiv(order.fullBuyAmount * remainingSell, order.fullSellAmount),
	};
}

/** New proposals precede refreshes; each group is ranked by native surplus. */
export function prioritizeCandidates(
	orders: readonly PollOrder[],
	hasActiveProposal: (orderUid: string) => boolean,
): RankedCandidate[] {
	return orders
		.flatMap((order) => {
			const candidate = toCandidateOrder(order);
			if (!candidate) return [];
			return [
				{
					candidate,
					estimatedNativeSurplus: order.estimatedNativeSurplus ?? 0n,
					needsSubmission: !hasActiveProposal(order.uid),
				},
			];
		})
		.sort((a, b) => {
			if (a.needsSubmission !== b.needsSubmission) return a.needsSubmission ? -1 : 1;
			if (a.estimatedNativeSurplus === b.estimatedNativeSurplus) return 0;
			return a.estimatedNativeSurplus > b.estimatedNativeSurplus ? -1 : 1;
		});
}
